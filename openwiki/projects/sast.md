---
type: Architecture
title: SAST & SCA static security scanning
description: Keyless, config-as-code Static Application Security Testing (SAST) and Software Composition Analysis (SCA) across four scanners — Semgrep, cargo-audit, pnpm-audit, and pip-audit — feeding one normalized allowlist-gated CI job (sast) in guardrails.yml.
tags: [security, sast, sca, semgrep, ci, gates, dependency-management]
resource: docs/runbooks/sast-scanning.md
timestamp: 2026-09-06T00:00:00Z
---

# SAST & SCA static security scanning

Keyless, config-as-code security scanning that runs on every PR. Four scanners cover the full
first-party surface at rest — no SaaS account, no CI secret. All findings funnel into one
normalized report; one `sast` gate in [CI/CD pipeline](/openwiki/projects/ci-cd-pipeline.md)
(`guardrails.yml`) decides pass or fail.

| Kind | Scanner | Surface |
|---|---|---|
| SAST | **Semgrep** (OSS) | TS/JS tree (BFF + frontend) + Python agent layer |
| SCA | **cargo audit** | Rust deps (`Cargo.lock`) |
| SCA | **pnpm audit** | JS deps (`pnpm-lock.yaml`) |
| SCA | **pip-audit** | Python deps (`agents/movie-assistant`) |

Rust *code* is outside Semgrep's scope — clippy (`pnpm nx lint mc-service`) owns Rust patterns;
cargo-audit covers only Rust *deps*. Config tree: `security/sast/`; full operator procedures in
`docs/runbooks/sast-scanning.md`.

## Blocking rule

```
blocking = severity ∈ {High, Critical}
           AND (kind == sast OR scope == runtime)
```

A High/Critical advisory in a **dev/build-only** dep is a non-blocking warning. Dependency scope
is computed per ecosystem (`cargo tree --edges no-dev`, `pnpm audit --prod`, `uv export --no-dev`).
Medium/Low findings are always warnings. SCA **always runs full** regardless of what changed —
a freshly-published advisory can hit an unchanged dep (FR-013), so a path-filter would miss it.

## Allowlist

Blocking findings not yet fixed are triaged into `security/sast/allowlist.yaml`. Required fields:

```yaml
- scanner: "pnpm-audit"
  id: "GHSA-example"
  locationPattern: "package@version"   # regex; FORWARD slashes; scope narrowly
  justification: "non-empty rationale"
  addedBy: "engineer-handle"
  # expiry: "YYYY-MM-DD"              # optional; sets a 14-day warning window
```

A blank `justification`/`addedBy` or an invalid `locationPattern` regex is a **gate error** (exit
2), not a silent pass. Full allowlist field rules and baseline-seeding steps: `security/sast/README.md`.

## Expiry and the 14-day warning window

Allowlist entries with an `expiry` date pass through three states:

| State | What the gate does |
|---|---|
| **Active** — more than 14 days out | Suppresses silently. |
| **Expiring soon** — 14 days or fewer out (inclusive) | Still suppresses; listed under `EXPIRING SOON`. |
| **Expired** — date has passed | Stops suppressing; finding re-blocks with an explanation. |

The window length is defined **once** in `scripts/allowlist-expiry.mjs` (`WARNING_WINDOW_DAYS = 14`)
and imported by both gates. A dedicated `--check-expiring` mode runs **weekly** (Friday) in the
`infra-image-scan` workflow and fails on any expiring, expired, or unmatched entry. This mode is
**never** run on pull requests.

## Gotchas

- **`pnpm why <pkg> --prod` without `-r` reports the wrong scope.** Without `-r` the command runs at
  the repo root only and prints nothing for a dep that is runtime-reachable via a sub-package (e.g.
  `mcm-app > @copilotkit/runtime > … > fast-uri`). That empty output is **not** "dev-only" — it is
  the wrong scope. The gate itself uses `pnpm audit --prod` across the whole workspace; when in
  doubt, trust the digest's tag (`[pnpm-audit] runtime` vs `[pnpm-audit/dev]`). This exact mistake
  wrongly accused the gate of a bug on 2026-07-21; the gate was right.

- **`semgrep.dev` is now in the egress allowlist — but adding it to the canonical list is only HALF
  the change (item #222, 2026-08-22).** Semgrep resolves the five `p/*` community packs in
  `security/sast/semgrep.yaml` from its public registry at scan time. That host was unallowlisted
  from day one, so Semgrep failed closed and left `security/sast/reports/findings.json` **empty**;
  `check-sast-findings.mjs` then exited 0 — a green that proved nothing. It was added to
  `.devcontainer/egress-allowlist.json`, but egress is enforced in **two layers**, and only one
  re-reads the committed file by itself: the in-VM iptables half re-applies from `init-firewall.sh`,
  while the **host-side sandbox policy is scoped per sandbox** and does not pick up a new destination
  until an operator re-applies it (`sbx policy allow network semgrep.dev --sandbox mcm` on the
  Windows host — see `docs/runbooks/devcontainer-sandbox.md` § 4). The committed entry does not tell
  you which world you are in. One command does:
  ```bash
  curl -sS -o /dev/null -w '%{http_code}\n' https://semgrep.dev/   # DNS failure / 000 => still vacuous
  node scripts/sast-scan.mjs --scope full --only semgrep            # exit >=2 => registry unreachable
  ```
  A Semgrep result you did not sanity-check this way is the same green either way, which is the
  whole trap.

- **…but SCA still works inside the devcontainer — `--only` gets you the half that matters.**
  `pnpm-audit`, `cargo-audit`, and `pip-audit` resolve from sources the egress allowlist already
  permits. Use `node scripts/sast-scan.mjs --scope full --only pnpm-audit` to verify a floor
  remediation before pushing. Measured on feature 057: a full-scope run left a 0-finding report the
  gate passed vacuously, while `--only pnpm-audit` proved the advisory was genuinely suppressed
  (then gone). **Check the finding COUNT, not just the exit code** — a 0-finding report and a
  0-blocking-finding report both print green.

- **pip-audit audits the INSTALLED venv, not a requirements file.** The orchestrator runs pip-audit
  against the synced venv (`uv sync` in `agents/movie-assistant` first). CI provisions this; a
  developer must do it locally. `pip-audit -r <requirements>` downloads an ephemeral venv (hangs
  >11 min, chokes on yanked versions) — do not use that form.

- **Unmatched allowlist entries are reported but do not move the exit code.** An entry that matches
  nothing this run is listed under `UNMATCHED ENTRIES`. The trap: pip-audit switched from CVE ids to
  PYSEC aliases; entries keyed on the old CVE ids silently matched nothing rather than expiring. The
  `--check-expiring` weekly run catches this, but the entry's own expiry date did not advance the
  warning — read `UNMATCHED ENTRIES` whenever an advisory you thought was accepted re-blocks.

- **Before raising a floor, check whether the lockfile is the lever, not the override.** Since
  feature 058 the gate prints an `OVERRIDE LEVERS` advisory section for any finding whose package
  already carries an override in `pnpm-workspace.yaml`. Example output:
  ```
  OVERRIDE LEVERS (advisory — does not affect this gate's result)
    Already permitted by an existing override — REFRESH THE LOCKFILE:
      • hono 4.12.29 — the override `>=4.12.25` ALREADY PERMITS 4.12.34; the lockfile is what pins
        4.12.29. The override needs no edit — refresh the lockfile: `pnpm update hono --lockfile-only`.
  ```
  **This distinction cost ten days of red once already.** `fast-uri`'s override `>=3.1.4 <4` already
  permitted the published fix 3.1.5; the lockfile pinned 3.1.4. The fix predated the advisory by three
  days. A four-week allowlist acceptance was written for something `pnpm update fast-uri --lockfile-only`
  would have cleared. `nanoid` repeated it eight days later. If the section says *refresh the lockfile*,
  editing the override is wasted work — the range is already correct. The section is advisory only and
  never changes the gate's exit code; it also prints for non-blocking findings, so a cheap fix can be
  made before severity promotes it into a blocker. Most of these are now cleared weekly by Renovate's
  `lockFileMaintenance` (see below) without anyone reading an advisory.

  **Two gotchas about Renovate `lockFileMaintenance` (feature 058, 2026-08-13):**
  - Its `schedule` key in `renovate.json` looks like a duplicate of the top-level schedule and
    **is not** — the option carries its own default (`before 4am on monday`) that beats the inherited
    value, and that window intersects neither cron under either DST offset. Delete the key as redundant
    and the refresh is enabled but can never fire, silently. `renovate-workflow.guard.test.mjs` fails
    if the key goes missing.
  - These refresh PRs now run `app-e2e`: a bad transitive floor is a **build-time** break that
    `nx test` passes straight over, so the E2E tier is the only one that catches it.

  What remains manual is the case the bot cannot propose: a floor that must rise past its own ceiling.
  Renovate essentially never raises the lower bound of a keyed override — and when it rewrites one it
  half-bumps — so the `check-override-consistency.mjs` guard is the answer.

- **An override floor has TWO halves and both must move.** Entries in `pnpm-workspace.yaml`'s
  `overrides:` map are keyed-range-on-range: `fast-uri@<3.1.5: '>=3.1.5 <4'`. Raise the value and
  leave the key stale, and the override reads as remediated but no longer excludes the vulnerable
  span. **Renovate produces exactly this mismatch by construction** — its built-in npm manager
  parses the key as an opaque dep name and cannot rewrite it. `scripts/check-override-consistency.mjs`
  runs on pull requests and fails a mismatched pair by name, so a half-remediation cannot merge
  even though it appears correct. Adding a custom Renovate manager does not fix this (the file is
  already managed; a second manager double-manages it) — the guard is the answer.

- **Remediate, do not re-date.** Deleting or extending an `expiry` converts a time-box into a
  permanent suppression. The legitimate exception — no published fix exists — requires the evidence
  written into the `justification`. Check npm/crates/PyPI before assuming: on feature 057 both
  "needs an acceptance" advisories turned out to have published fixes.

- **`p/secrets` stays off.** `secret-scan.mjs` is the sole owner of credential detection (FR-006).
  Do not double-gate with Semgrep's `p/secrets` ruleset.

- **No caching yet.** `actions/cache` is not mirrored on the self-hosted runner, so cargo-audit is
  compiled fresh each CI run (~2–3 min). A monthly-keyed cache of `~/.cargo/bin/cargo-audit` and
  `~/.cargo/advisory-db` is a future optimization.

- **Paths in `locationPattern` must use forward slashes.** Allowlist entries are matched against
  paths normalized to forward slashes so they are portable across the Windows dev host and the Linux
  CI runner. A pattern written with backslashes matches nothing on the runner and passes silently on
  the Windows side — the gate accepts it, but the finding re-blocks in CI.

- **A rule that has gone BLIND produces the same gate output as a remediated one — read `RULES THAT
  COULD NOT RUN`, not just the finding count.** A Semgrep rule that could not execute is recorded in
  `errors[]`, never in `results[]`, so it contributes zero findings. Its allowlist entry lands in
  `UNMATCHED ENTRIES` with wording that implies the code is clean. Measured on `main` 2026-09-06:
  `gha-curl-pipe-shell` (from `p/owasp-top-ten`) re-parses a step's `run:` block as Bash via
  `metavariable-pattern` — but nearly every run-step here is wrapped in the ci-log-step heredoc
  (feature 042), which that sub-parser cannot read. Result: **36 errors, 0 findings**, while six
  `curl … | sh` lines sat in the workflows unexamined.

  The gate now prints a `RULES THAT COULD NOT RUN` section listing each blinded rule with its error
  and file counts; any `UNMATCHED` entry whose rule appears there is annotated `↳ this rule could
  not run`. This is advisory and never moves the exit code — these rules error on every run, and a
  gate that goes red on a standing condition stops being read. The replacement coverage is
  `mcm-ci-curl-pipe-shell` (item #224, `security/sast/rules/mcm-ci-curl-pipe-shell.yaml`), a
  text-level rule using `pattern-regex` / `pattern-not-regex` — no sub-parser, so the heredoc is
  irrelevant to it. `scripts/__tests__/ci-curl-pipe-shell-rule.guard.test.mjs` fails if anyone
  "improves" it back into a `metavariable-pattern` form.

- **Accepted `curl | sh` installers are named in the rule, not in `allowlist.yaml`.** An allowlist
  entry keys on `path:line`: accepting the six existing lines there is either line-pinned (every edit
  above them re-blocks an unrelated PR) or file-wildcarded (a NEW `curl | sh` in an already-listed
  workflow is suppressed unexamined). The accepted hosts live in `mcm-ci-curl-pipe-shell`'s
  `pattern-not-regex` instead; adding an installer means editing that list with a comment explaining
  why. Currently accepted: `sh.rustup.rs`, `astral.sh/uv/<VERSION>/install.sh` (version-pinned path
  only — the unversioned form is deliberately excluded), and `get.maestro.mobile.dev` (no versioned
  endpoint exists; the pin is enforced by `renovate-workflow.guard.test.mjs` instead).

- **Workflow YAML was not a scan target on pull requests until item #224.** `--scope changed` builds
  an explicit target list for Semgrep; only files matched by `isScanTarget()` make it in. Before
  item #224, workflow YAML was absent from that list, so a `curl … | sh` added to a workflow on a PR
  was gated on nothing and first appeared on the post-merge full scan. Both
  `.forgejo/workflows/*.y[a]ml` and `.github/workflows/*.y[a]ml` are now included. The scope was
  widened deliberately — not every `.yml` tree-wide, which would drag compose files, Komodo syncs,
  and the security config tree into a scan against packs written for TS/JS/Python code.

- **`--test-rules` enforces fixtures; without it they were decoration for months.** The four original
  custom rules shipped with `semgrep --test` fixtures, but `--test-rules` appeared in no workflow, no
  Nx target, and no script until item #224 — so the `ruleid:`/`ok:` annotations had been decoration
  in the tier that decides whether a High blocks a merge. `sast-scan.mjs --test-rules` now runs ahead
  of the scan in the CI `sast` job. It also fails on a rule with **no** fixture — `semgrep --test`
  skips unfixtured rules silently and still prints `N/N ✓`, which is the same false assurance as a
  blinded rule. A YAML rule's fixture must be named `<rule>.test.yml`; a bare `<rule>.yaml` would be
  loaded as a second rule by `--config security/sast/rules/`.

See [CI/CD pipeline](/openwiki/projects/ci-cd-pipeline.md) for how the `sast` job sits in the
`guardrails.yml` workflow, and `security/sast/README.md` for the full config reference and custom
MCM rule definitions.
