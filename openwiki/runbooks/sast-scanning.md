---
type: Runbook
title: SAST & SCA static scanning
description: Keyless, config-as-code static application security testing (Semgrep) plus software composition analysis (cargo-audit, pnpm audit, pip-audit) across the whole dependency graph, normalized into one blocking `sast` CI gate.
resource: docs/runbooks/sast-scanning.md
tags: [security, sast, sca, ci, runbook]
timestamp: 2026-08-13T17:17:54+00:00
---

# SAST & SCA static scanning

Four scanners — Semgrep (TS/JS + Python source), cargo audit (Rust deps), pnpm audit (JS deps), and
pip-audit (Python deps) — feed one normalized findings report and one blocking `sast` CI job. It
complements [DAST scanning](/openwiki/runbooks/dast-scanning.md): DAST exercises the running app,
this scans source and the dependency graph at rest. It is also disjoint from
[infra-image scanning](/openwiki/runbooks/infra-image-scanning.md), which scans pulled third-party
container images rather than first-party code or first-party dependency graphs.

## Gotchas

- **pip-audit audits the installed venv, not a requirements file.** Resolving a requirements file in
  an ephemeral venv downloads the whole dependency graph and can hang for 11+ minutes on yanked
  versions. The orchestrator instead audits the already-synced agent venv directly — CI must `uv sync`
  the agent layer first, and a developer's venv must be synced for a local run to be meaningful.
- **Keyless and fail-closed.** All advisory data (Semgrep registry, RustSec, npm advisories, OSV) is
  fetched anonymously at scan time; if any fetch fails, that scanner fails the job rather than
  reporting a false clean. No secret is ever required — see
  [Secrets management](/openwiki/invariants/secrets-management.md) for the broader no-clear-text-secrets
  posture this fits into.
- **The SCA half runs full on every push, unconditionally** — a newly published advisory can hit an
  unchanged dependency, so it is never path-gated. This means `main` can legitimately go red on a
  dependency nobody touched; that is the gate working, not a defect, and it recurs.
- **Only runtime-scope SCA blocks the gate.** A dependency's blocking status depends on whether it is
  reachable from a runtime path across the whole workspace, not just the root package — checking scope
  by hand requires a recursive, workspace-spanning query, not a root-only one; getting this wrong has
  previously produced a false "gate bug" report.
- **`pnpm why <pkg> --prod` without `-r` reports the wrong scope.** Without `-r` the command runs at
  the repo root only and prints nothing for a dep that is runtime-reachable via a sub-package (e.g.
  `mcm-app > @copilotkit/runtime > … > fast-uri`). That empty output is **not** "dev-only" — it is
  the wrong scope. The gate itself uses `pnpm audit --prod` across the whole workspace; when in
  doubt, trust the digest's tag (`[pnpm-audit] runtime` vs `[pnpm-audit/dev]`). This exact mistake
  wrongly accused the gate of a bug on 2026-07-21; the gate was right.
- **A fixable High must be bumped, never allowlisted.** The allowlist is for findings with no fix
  yet; suppression is gate-only and the finding stays visible in the report regardless.
- **Rust source itself is out of Semgrep's scope** — clippy covers Rust source patterns and
  cargo-audit covers only Rust dependencies, so the mc-service Rust surface relies on clippy + review
  for the patterns Semgrep enforces elsewhere.
- **The gate passes vacuously in the devcontainer — a local green proves nothing about a new
  allowlist entry.** Semgrep cannot reach its rule registry through the egress allowlist, so it
  exits 1 and leaves `security/sast/reports/findings.json` **empty** — the reason is recorded in
  `scanners[].error`, which is easy to miss. Running `check-sast-findings.mjs` then exits 0 on zero
  findings, which is not evidence that an allowlist entry matches anything. **To test an allowlist
  entry locally, hand the gate a synthetic `findings.json`** carrying the exact `scanner`/`id`/location
  triples you expect, plus a **negative control** (a finding the entry must NOT suppress). Otherwise
  push and let CI answer.
- **…but "the tier cannot run here" is the wrong conclusion — `--only` gets you the SCA half.**
  The vacuous pass above is a fact about **Semgrep**, not about the gate. Only Semgrep needs
  `semgrep.dev`; `pnpm-audit`, `cargo-audit` and `pip-audit` resolve their advisory data from sources
  the egress allowlist already permits. So the whole SCA half runs to completion locally:
  ```bash
  node scripts/sast-scan.mjs --scope full --only pnpm-audit   # 55 findings, 2 blocking — a real report
  node scripts/check-sast-findings.mjs
  ```
  This matters because every dependency-floor remediation is an SCA finding, and those are exactly
  the changes you want to verify before pushing. Measured on feature 057: the full-scope run
  fail-closed on Semgrep and left a 0-finding report the gate passed vacuously, while
  `--only pnpm-audit` proved both target advisories were genuinely suppressed beforehand and genuinely
  gone afterwards. **Check the finding COUNT, not the exit code** — a report with 0 findings and a
  report with no blocking findings print the same green.
- **An override floor has TWO halves and both must move.** Entries in `pnpm-workspace.yaml`'s
  `overrides:` map are a range keyed on a range — `fast-uri@<3.1.5: '>=3.1.5 <4'` — where the key
  names the vulnerable span excluded and the value the patched floor forced. Raise the value alone
  and you get an override that reads as remediated while no longer excluding the version its own key
  names. `scripts/check-override-consistency.mjs` enforces `key's exclusive upper bound == value's
  inclusive lower bound` on every pull request, scoped to keys carrying an `@<range>` suffix (the
  plain pins `react-dom`, `postcss`, `@expo/dom-webview` have no key half and are out of scope).
  Renovate produces exactly this mismatch when it proposes a floor raise, so expect bot PRs against
  this map to need their key half fixed by hand.
- **Unmatched allowlist entries are reported but do not block.** An entry that matches nothing this
  run is listed under `UNMATCHED ENTRIES`. The trap: pip-audit switched from CVE ids to PYSEC
  aliases; entries keyed on the old CVE ids silently matched nothing rather than expiring. The
  `--check-expiring` weekly run catches this, but the entry's own expiry date did not advance the
  warning — read `UNMATCHED ENTRIES` whenever an advisory you thought was accepted re-blocks.
- **Expiry has a 14-day warning window before it blocks.** Allowlist entries with an `expiry` date
  surface `EXPIRING SOON` warnings for the 14 days before the date, then re-block when expired. The
  window length is defined once in `scripts/allowlist-expiry.mjs` (`WARNING_WINDOW_DAYS = 14`) and
  imported by both gates. A dedicated `--check-expiring` mode runs **weekly** (Friday) in the
  `infra-image-scan` workflow and fails on any expiring, expired, or unmatched entry; this mode is
  never run on pull requests.
- **Remediate, do not re-date.** Deleting or extending an `expiry` is how a time-box becomes
  permanent. The legitimate exception — no published fix exists — is modelled by the `image-size`
  pair and requires the evidence written into the justification. Check npm before assuming: on
  feature 057 both "needs an acceptance" advisories turned out to have published fixes.

Full scanner matrix, local invocation, the CI gate steps, the triage/allowlist workflow, and the
step-by-step "gate went red on an untouched dep" playbook: `docs/runbooks/sast-scanning.md`.
