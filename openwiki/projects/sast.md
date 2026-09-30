---
type: Architecture
title: SAST & SCA static security scanning
description: Keyless, config-as-code Static Application Security Testing (SAST) and Software Composition Analysis (SCA) across four scanners — Semgrep, cargo-audit, pnpm-audit, and pip-audit — feeding one normalized allowlist-gated CI job (sast) in guardrails.yml.
tags: [security, sast, sca, semgrep, ci, gates, dependency-management]
resource: docs/runbooks/sast-scanning.md
sources:
  - id: openwiki-source-0efadc7633f45e85ee45a617
    resource: repo://.devcontainer/egress-allowlist.json
  - id: openwiki-source-fd77a504cc309a02ead6fecf
    resource: repo://.forgejo/workflows/guardrails.yml
  - id: openwiki-source-7bd434a17ed7c27916b1d2ae
    resource: repo://.forgejo/workflows/infra-image-scan.yml
  - id: openwiki-source-ae915b1b987b44cca82fc6bf
    resource: repo://docs/runbooks/sast-scanning.md
  - id: openwiki-source-40275cb92c3610938f16ade3
    resource: repo://pnpm-workspace.yaml
  - id: openwiki-source-ac5e6320dc9ac6ac80ffcd19
    resource: repo://scripts/__tests__/allowlist-expiry-wiring.guard.test.mjs
  - id: openwiki-source-1813b4b5c82e84caead4e177
    resource: repo://scripts/__tests__/ci-curl-pipe-shell-rule.guard.test.mjs
  - id: openwiki-source-b24a848c671edad8616a78b0
    resource: repo://scripts/__tests__/sast-scan.guard.test.mjs
  - id: openwiki-source-60011cd55e5b787da8893ea3
    resource: repo://scripts/allowlist-expiry.mjs
  - id: openwiki-source-be4449db5d1cd6939f816b1e
    resource: repo://scripts/check-override-consistency.mjs
  - id: openwiki-source-3597b8f7b798d708bd7e75a1
    resource: repo://scripts/check-sast-findings.mjs
  - id: openwiki-source-0b13188628bc70e422253f37
    resource: repo://scripts/gen-egress-policy.mjs
  - id: openwiki-source-b202cb0e9ae4a5b1b46e466a
    resource: repo://scripts/lib/scanner-retry.mjs
  - id: openwiki-source-302b6b882f29dba1e61bfa9e
    resource: repo://scripts/override-lever.mjs
  - id: openwiki-source-bd64475e04b69688a7d80d8d
    resource: repo://scripts/sast-scan.mjs
  - id: openwiki-source-c375ab176697b193168e58a4
    resource: repo://security/sast/allowlist.yaml
  - id: openwiki-source-dc4b183eb81f4bf37332aff8
    resource: repo://security/sast/README.md
  - id: openwiki-source-a19234abfb32b98f346a6d4f
    resource: repo://security/sast/rules/mcm-auth-before-authz.yaml
  - id: openwiki-source-d7ba5b8b7daf5b7b6fcb0f5a
    resource: repo://security/sast/rules/mcm-ci-curl-pipe-shell.yaml
  - id: openwiki-source-2f9e6a413d6fe437ec94e8f5
    resource: repo://security/sast/rules/mcm-no-jwt-payload-tracing.yaml
  - id: openwiki-source-5bfacc731db8fdb56be7df9d
    resource: repo://security/sast/rules/mcm-no-token-logging.yaml
  - id: openwiki-source-9372ce7270e3121a73a61934
    resource: repo://security/sast/semgrep.yaml
  - id: openwiki-source-8462fd09d611de231506af9b
    resource: repo://security/sast/severity-map.yaml
generated: { by: "openwiki/0.6.0", at: "2026-09-30T10:57:51.938Z" }

---

# SAST & SCA static security scanning

Keyless, config-as-code security scanning that runs on every PR. Four scanners cover the full
first-party surface at rest — no SaaS account, no CI secret. All findings funnel into one
normalized report; one `sast` gate in [CI/CD pipeline](./ci-cd-pipeline.md)
(`guardrails.yml`) decides pass or fail.

| Kind | Scanner | Surface |
|---|---|---|
| SAST | **Semgrep** (OSS) | TS/JS tree (BFF + frontend) + Python agent layer |
| SCA | **cargo audit** | Rust deps (`Cargo.lock`) |
| SCA | **pnpm audit** | JS deps (`pnpm-lock.yaml`) |
| SCA | **pip-audit** | Python deps — **all four** surfaces: `agents/movie-assistant`, `mcp-servers/{movie-mcp,spreadsheet-mcp,web-api-mcp}` |

Rust *code* is outside Semgrep's scope — clippy (`pnpm nx lint mc-service`) owns Rust patterns;
cargo-audit covers only Rust *deps*. Config tree: `security/sast/`; full operator procedures in
`docs/runbooks/sast-scanning.md`.

```mermaid
flowchart TD
  S1["Semgrep: TS/JS and Python"] --> N
  S2["cargo-audit: Cargo.lock"] --> N
  S3["pnpm audit: pnpm-lock.yaml"] --> N
  S4["pip-audit: four Python venvs"] --> N
  N["orchestrator: normalize severity, derive runtime scope and blocking"] --> F["findings.json plus SARIF, summary, per-scanner native output"]
  N -->|a scanner fails| FC["fail closed: scanners error recorded, scan exits 1 after writing a partial report"]
  F --> G["check-sast-findings.mjs"]
  G --> P["exit 0: no un-allowlisted blocking finding"]
  G --> X["exit 1: un-allowlisted blocking finding, or gate-scope asymmetry"]
```

Four scanners feed one normalization step, one report, and one gate that has exactly two blocking exit
paths — the second of which is about the gate's own coverage, not about the code.

## Normalized severity scale

All four scanners' native severities map onto one **Critical / High / Medium / Low** scale via
[`severity-map.yaml`](../../security/sast/severity-map.yaml), applied by the orchestrator
(`scripts/sast-scan.mjs`), never by the gate. The gate consumes only the already-normalized value,
so changing the mapping never touches gate code. An unmapped native value is a **hard error** —
there is no silent default. cargo/pip advisories with no CVSS score map to `High`
(`unscoredAdvisory`); cargo informational warnings map to `Low`.

Semgrep maps **both** of its severity domains — the classic `ERROR`/`WARNING`/`INFO` and the
`CRITICAL`/`HIGH`/`MEDIUM`/`LOW` scale that newer community-pack rules emit — so the orchestrator
never fails fast on a legitimate Semgrep value. One consequence of the conservative defaults is worth
knowing before triage: `pip-audit`/OSV rarely carries a CVSS score, so **every pip-audit finding
normalizes to `High`** — any runtime-scope Python advisory blocks.

## Blocking rule

```
blocking = severity ∈ {High, Critical}
           AND (kind == sast OR scope == runtime)
```

A High/Critical advisory in a **dev/build-only** dep is a non-blocking warning. Dependency scope
is computed per ecosystem (`cargo tree --edges no-dev`, `pnpm audit --prod`, `uv export --no-dev`).
Medium/Low findings are always warnings. SCA **always runs full** regardless of what changed —
a freshly-published advisory can hit an unchanged dep (FR-013), so a path-filter would miss it.

Every unreadable input falls the same way: if a scanner's runtime dep-set cannot be computed, scope
defaults to **runtime** (conservative → blocking), and a RustSec `cvss` that is a CVSS *vector string*
rather than a number is treated as `unscored` → `High`, because a vector cannot be scored without a
calculator. The design rule is that an unknown must never silently downgrade a finding out of the
blocking set.

## Custom MCM rules

Project-specific invariants live in [`security/sast/rules/`](../../security/sast/rules/), loaded by the
orchestrator as a **second** `--config` (so their inline test fixtures are never scanned as product
code). Four enforce house rules no community pack covers; the fifth replaces one that went blind here.

| Rule | Native → normalized | Enforces |
|---|---|---|
| `mcm-no-console-in-bff` | WARNING → Medium (warn) | no direct `console.*` in `src/bff-server/**` or `bff-api/**` |
| `mcm-no-token-logging` | ERROR → High (block) | no logging of a raw token/JWT/`authorization`/session id/email/password |
| `mcm-auth-before-authz` | ERROR → High (block) | a `createMcServiceClient(...)` call not textually preceded by `requireAuth`/`requireMcUser` in the same function |
| `mcm-no-jwt-payload-tracing` | ERROR → High (block) | no logging/tracing of a decoded JWT payload, on TS/JS + Python |
| `mcm-ci-curl-pipe-shell` | ERROR → High (block) | no `curl … \| sh` in a workflow step from a URL outside that rule's accepted, pinned list |

Each rule's own YAML header records its **documented limitation**, and those limits are the reason
several allowlist entries exist rather than bugs in the rule: `mcm-auth-before-authz` is structural
best-effort (a guard must appear textually earlier in the *same* function body), `mcm-no-token-logging`
matches by identifier/property *name* (so an aliased value escapes it, and a same-named non-sensitive
field can false-positive), and `mcm-no-jwt-payload-tracing` covers TS/JS + Python only. Rules are
proved before use: `--test-rules` (below) runs their fixtures ahead of every scan.

## Allowlist

Blocking findings not yet fixed are triaged into `security/sast/allowlist.yaml`. The match key is
`scanner` equal **AND** `id` equal **AND** `locationPattern` matching the finding's location.
Required fields:

```yaml
- scanner: "pnpm-audit"
  id: "GHSA-example"
  locationPattern: "package@version"   # regex; FORWARD slashes; scope narrowly
  justification: "non-empty rationale"
  addedBy: "engineer-handle"
  # expiry: "YYYY-MM-DD"              # optional; sets a 14-day warning window
```

A blank `justification`/`addedBy` or an invalid `locationPattern` regex is a **gate error** (exit
2), not a silent pass. Suppression is **gate-only**: an allowlisted finding leaves the failure set
but stays visible in `findings.json` and the reports, printed as `allowlisted by …`. Full allowlist
field rules and baseline-seeding steps (`--emit-allowlist`): `security/sast/README.md`.

Two mechanical notes that make the difference between an entry that works and one that reads as
working. Paths are normalized to forward slashes before matching, so one pattern is portable across the
Windows dev host and the Linux CI runner (see the gotcha below). And the generated
`reports/allowlist.proposed.yaml` writes its dedupe key with `\u0000` as an **escape sequence**, never
as a raw NUL byte — a raw one makes `grep` treat the whole file as binary and print no matching lines
at all (item #448), which is a confusing way to lose a triage session.

## Expiry and the 14-day warning window

Allowlist entries with an `expiry` date pass through three states:

| State | What the gate does |
|---|---|
| **Active** — more than 14 days out | Suppresses silently. |
| **Expiring soon** — 14 days or fewer out (inclusive) | Still suppresses; listed under `EXPIRING SOON`. |
| **Expired** — date has passed | Stops suppressing; finding re-blocks with an explanation. |

```mermaid
stateDiagram-v2
  [*] --> Active: entry written with an expiry
  Active --> Expiring: 14 days or fewer remain
  Expiring --> Expired: the expiry date passes
  Expired --> [*]: finding re-blocks and must be remediated or re-justified
```

Both window boundaries are inclusive: exactly 14 days out is already *expiring*, and an entry
suppresses through the whole of its final day. Classification is computed on **UTC date
boundaries** from a `today` passed in by the caller, so a runner's timezone or a DST transition
cannot move an entry between `expiring` and `expired`.

The window length is defined **once** in `scripts/allowlist-expiry.mjs`
(`WARNING_WINDOW_DAYS = 14`) and imported by both gates. A dedicated `--check-expiring` mode runs
**weekly** (Friday) in the `infra-image-scan` workflow, `always()`-guarded and pinned to
`github.event_name == 'schedule'`, and fails on any expiring or expired entry. This mode is **never**
run on pull requests — `infra-image-scan` also serves `pull_request`, so a wrong `if:` would block
every PR the moment an entry entered the window, and the failure would be *scheduled* rather than
immediate. Unmatched detection is not part of the SAST half of that weekly signal (see below).

## The `sast` job and the two commands that matter

`guardrails.yml`'s `sast` job is keyless (no `${{ secrets }}`), has **no `paths:` filter**, and runs
on every push/PR. In order: install uv + Rust/cargo-audit + `pnpm install`, `uv sync` each of the
four Python surfaces, `check-sast-findings.mjs --selftest`, `sast-scan.mjs --test-rules`,
`sast-scan.mjs` (`--scope changed` on PRs, `--scope full` on push), `check-sast-findings.mjs` (the
gate), then upload the `sast-report` artifact always. Reports land in `security/sast/reports/`
(gitignored): `findings.json` is the gate input; `findings.sarif`, `summary.txt` and
`<scanner>-native.json` are for triage. The changed-scope run is preceded by a `git fetch` of the PR
base ref, because the diff that builds the target list needs it.

The job's `timeout-minutes: 25` is a deliberate value, not a default left alone: an intermediate
revision raised it to 40 because **pnpm 11.5.3's `pnpm audit` took 550 s where 10.33.0 took ~0 s** — a
real regression in that release, since fixed (11.17.0 puts the whole SCA scan back at ~2 s). Keeping
the larger budget would be the "timeout bump that quietly hides a slow or hung step". If a future pnpm
regresses audit again, raise it deliberately rather than treating a large budget as normal.

## How the instruments are proved

Every tier here has a way to fail *before* it is trusted with a merge, and each exists because the
alternative — a green that proves nothing — has already happened once:

| Instrument | Proves |
|---|---|
| `check-sast-findings.mjs --selftest` | the gate's fail / allowlist-suppress / dev-warn / clean / blank-field-reject / expiry paths, plus the warning tier, unmatched detection, blinded-rule reporting, per-surface pip-audit suppression, gate-scope asymmetry and the absent-report path — asserted on **output** as well as exit code, since the binding constraint of the warning tier is that the exit code does *not* move |
| `sast-scan.mjs --test-rules` | the custom rules still match what they claim (see below) |
| `scripts/__tests__/sast-scan.guard.test.mjs` | pure normalization, the blocking rule, scope classification, toolchain fail-fast, the blinded-rule summary, `isScanTarget()` for both workflow trees and Dockerfile spellings, fixture pairing, and the `PYTHON_SURFACES` model — the built report is validated against the findings **schema**, which is the gate's input contract |
| `scripts/__tests__/sast-scan-retry.guard.test.mjs` | both directions of the transient classifier: the exact run-3328 output retries, a real fault (unsynced venv, unparseable lockfile, panic) fails on the first attempt, and an advisory *title* containing "error"/"timeout"/a status phrase does not |
| `scripts/__tests__/ci-curl-pipe-shell-rule.guard.test.mjs` | the curl-pipe-shell rule's own regexes, applied to the real workflows — including that the pattern still *sees* at least six installers, so the acceptance assertions cannot pass vacuously |
| `scripts/__tests__/allowlist-expiry-wiring.guard.test.mjs` | the `--check-expiring` step's `if:` (schedule-guarded *and* `always()`-guarded), that no other workflow invokes `--check-expiring`, the override-consistency gate's presence on PRs, and the item #418/#484 recorder that publishes the **measured** `github.event_name` and step outcomes as the `infra-image-scan/expiry` commit status — asserted statically because a missing step and a passing step look identical from a job's tick |

The retry guard's shape is worth copying: the usual outcome of a retry is that it silently never
triggers, so the classifier and retry driver are exported and tested directly rather than inferred from
a scan that happened to pass.

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
  node scripts/sast-scan.mjs --scope full --only semgrep            # exit 1 + "[semgrep] scan failed … rules/registry may be unreachable" => unreachable (exit 2 is bad arguments only)
  ```
  A Semgrep result you did not sanity-check this way is the same green either way, which is the
  whole trap.

  The committed file is the **single** source for both halves: `scripts/gen-egress-policy.mjs` emits
  the host-side sandbox policy (`--format sbx-policy`) *and* the in-VM firewall domain array
  (`--format ipset-domains`) from `.devcontainer/egress-allowlist.json`. Neither emitted form is ever
  hand-edited and no consumer keeps its own copy — two enforcement layers with two hand-maintained
  lists turn a blocked fetch into the union of two allowlists, and diagnosis into guesswork.

- **`api.osv.dev` is the same trap on the SCA half, and it has its own entry for the same reason
  (item #394).** `pip-audit` runs as `… pip-audit -s osv`, which resolves `https://api.osv.dev/v1/query`
  at scan time — another runtime fetch no toolchain image can bake. With that host blocked the scanner
  **fails closed**, so the symptom is not a vacuous green but an un-runnable job:
  `pip-audit: NOT RUN — httpx ConnectError: … Failed to resolve 'api.osv.dev'`. The workaround feature
  068 used, `-s pypi`, is a **different** feed whose equivalence to OSV is asserted rather than
  guaranteed — it was validated for sensitivity before being trusted, which is work the entry removes
  the need for. Both hosts (item #222, item #394) are recorded in the canonical list as the same shape
  of defect: a merge-blocking gate that had become CI-only *by accident rather than by decision*, its
  failures only ever visible after a push. This one is a **query** host, not telemetry — pip-audit sends
  the package names and versions it is auditing and receives advisories back.

- **…but SCA still works inside the devcontainer — `--only` gets you the half that matters.**
  `pnpm-audit`, `cargo-audit`, and `pip-audit` resolve from sources the egress allowlist already
  permits. Use `node scripts/sast-scan.mjs --scope full --only pnpm-audit` to verify a floor
  remediation before pushing. Measured on feature 057: a full-scope run left a 0-finding report the
  gate passed vacuously, while `--only pnpm-audit` proved the advisory was genuinely suppressed
  (then gone). **Check the finding COUNT, not just the exit code** — a 0-finding report and a
  0-blocking-finding report both print green.

  Why a *failed* Semgrep run leaves a **0**-finding report rather than a partial one: the orchestrator
  runs the scanners in order (`semgrep`, `cargo-audit`, `pnpm-audit`, `pip-audit`) and **breaks out of
  the loop on the first failure**, recording `ran: false` plus `scanners[].error` for that scanner.
  The report, SARIF and summary are still written before the non-zero exit, so the artifact is
  well-formed and empty — the scanners after the failed one never ran at all in that invocation. A
  missing toolchain is the same shape: `assertToolchain` refuses to skip a language surface (FR-015)
  and fails the scan naming the scanner.

- **pip-audit audits the INSTALLED venv, not a requirements file — and audits all four Python
  surfaces.** Since feature 068 pip-audit runs against `agents/movie-assistant`, `mcp-servers/movie-mcp`,
  `mcp-servers/spreadsheet-mcp`, and `mcp-servers/web-api-mcp` — each with its **own** dep graph and
  runtime classification. `uv sync` all four before a local run; an unsynced surface **fails** the
  scan, it is never silently skipped. CI provisions all four venvs. `pip-audit -r <requirements>` resolves
  an ephemeral venv (hangs >11 min, chokes on yanked versions) — do not use that form. Two further
  details of the working invocation: it runs `uv run --no-sync --with pip-audit pip-audit --format json
  -s osv`, and its findings are then intersected with the `uv export` dep-set so pip-audit's own
  ephemerally-injected dependencies never surface as findings. `--no-sync` is what makes "the venv is
  not synced" a real failure rather than a silent re-resolution.

- **pip-audit findings are project-qualified; allowlist `locationPattern`s should be surface-anchored.**
  Since feature 068 each finding's location names its surface: `mcp-servers/web-api-mcp:click@8.5.0`,
  not `click@8.5.0`. An allowlist entry should normally be anchored:
  `^mcp-servers/web-api-mcp:click@.*`. Two static checks enforce this at scan time, before any findings
  are compared: (1) `assertKnownPythonSurfaces` fails the scan if a Python project directory carrying a
  `uv.lock` is not registered in `PYTHON_SURFACES` (`scripts/sast-scan.mjs`) — adding a project without
  registering it produces a hard error, not a silent omission; (2) `assertPipAuditAllowlistShape` fails
  the scan if an anchored `locationPattern` (leading `^`) names a surface that does not exist in
  `PYTHON_SURFACES` — a dead anchor can never match, so it suppresses nothing: a real finding would
  still block, and the failure exists so nobody believes a suppression is in force when it is not. Drop the leading `^` only when you deliberately mean the suppression to span every
  Python surface. **Adding a new Python project?** Register it in `PYTHON_SURFACES` and add a `uv sync`
  step to the `sast` CI job.

- **Unmatched allowlist entries are reported but do not move the exit code.** An entry that matches
  nothing this run is listed under `UNMATCHED ENTRIES`. The trap: pip-audit switched from CVE ids to
  PYSEC aliases; entries keyed on the old CVE ids silently matched nothing rather than expiring —
  an entry keyed on an exact advisory id **does not expire, it just quietly matches nothing**.
  Unmatched detection only runs for scanners that produced at least one finding, so a skipped,
  failed or clean scanner never flags its whole entry set — and entry identity for this check is a
  positional key (`<index>:<scanner>:<id>`), not the advisory id, because one id can appear in
  several entries.

  **For SAST, the weekly run cannot flag an unmatched entry at all.** `--check-expiring` executes
  inside `infra-image-scan`, which produces no SAST report, so unmatched detection is skipped there
  (the script says so in its log). The weekly signal covers expiring/expired only; a SAST entry that
  quietly matches nothing is visible **solely** in the report-only `UNMATCHED ENTRIES` section of a
  normal gate run. Read it there whenever an advisory you thought was accepted re-blocks.

- **The `--check-expiring` step runs `always() && github.event_name == 'schedule'`, and its SAST half
  must tolerate an ABSENT report.** Two *different* faults live here and both were silent, so read them
  as one rule each. (1) The step's SAST half runs inside `infra-image-scan`, which never produces
  `security/sast/reports/findings.json`. `check-sast-findings.mjs` announces the ENOENT on stdout and
  synthesises `{ findings: [], reportAbsent: true }`; a report that *exists* but is unparseable is still
  exit 2, and a report missing `generatedAtScope` is still a hard error. That absent-report object used
  to throw inside the gate-scope asymmetry check, and `bash -e` then skipped the infra-image expiry
  check on the next line — **both expiry tiers were silently dead from 2026-09-12** (measured on the
  2026-09-25 weekly sweep, run 3946). The exemption is keyed on the explicit `reportAbsent` marker,
  never on a missing field, because "a report exists and omits its scope" is the fault the guard was
  written for. (2) The step sat behind a bare `if: github.event_name == 'schedule'`, and a failed step
  skips every later step that is not `always()`-guarded — so on any week the CVE gate above went red,
  the weekly expiry warning did not run, which is the week it is most likely to have something to say.
  Measured on run 3521 (the 2026-09-18 cron, three `amqp091-go` CRITICALs): the recorder posted
  `event_name=schedule expiry_step=skipped`, proving the `if:` evaluated true and only the upstream
  failure could have caused the skip. `always()` alone would run the check on every PR and block them
  all, so the schedule guard survives *inside* it, and the body suppresses `cancelled` from `job.status`
  so a superseded run is not turned into a failure for a commit that was never broken. The check is
  report-only, so it can never mask a red gate or turn one green.

- **Before raising a floor, check whether the lockfile is the lever, not the override.** Since
  feature 058 the gate prints an `OVERRIDE LEVERS` advisory section for any finding whose package
  already carries an override in `pnpm-workspace.yaml`. Example output:
  ```
  OVERRIDE LEVERS (advisory — does not affect this gate's result)
    Already permitted by an existing override — REFRESH THE LOCKFILE:
      • hono 4.12.29 — the override `>=4.12.25` ALREADY PERMITS 4.12.34; the lockfile is what pins
        4.12.29. The override needs no edit — refresh the lockfile: `pnpm update hono --lockfile-only`.
  ```
  The section has a **second half**, and it is the one that says *raise the floor*:
  ```
    Not reachable by the current override — RAISE THE FLOOR (both halves):
      • nanoid 3.3.17 — … Raise the floor, and BOTH HALVES move together: `nanoid@<3.3.18: '>=3.3.18 <4'`
        (currently `nanoid@>=3.0.0 <3.3.18: '>=3.3.18 <4'`). …
  ```
  Advice is deduped on **package + resolution + action**, so `hono@4.12.29` carrying four advisories
  produces one line rather than four, while a second resolution of the same package still reports.
  **This distinction cost ten days of red once already.** `fast-uri`'s override `>=3.1.4 <4` already
  permitted the published fix 3.1.5; the lockfile pinned 3.1.4. The fix predated the advisory by three
  days. A four-week allowlist acceptance was written for something `pnpm update fast-uri --lockfile-only`
  would have cleared. `nanoid` repeated it eight days later. If the section says *refresh the lockfile*,
  editing the override is wasted work — the range is already correct. The section is advisory only and
  never changes the gate's exit code; it also prints for non-blocking findings, so a cheap fix can be
  made before severity promotes it into a blocker. Most of these are now cleared weekly by Renovate's
  `lockFileMaintenance` (see below) without anyone reading an advisory.
  The lever logic itself lives in `scripts/override-lever.mjs` (pure, no I/O, no clock): it
  deliberately returns nothing rather than guessing when the override map or a version cannot be
  read, because an aid that cannot read its input must not obstruct the gate it prints beside.

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
  span. The guard's invariant is exact — **the key's exclusive upper bound must equal the value's
  inclusive lower bound** — and it is scoped to keys carrying an `@<range>` suffix: the plain pins
  (`react-dom`, `postcss`, `@expo/dom-webview`) have no key half and are out of scope by design. A key
  whose half cannot be compared (a range with no `<` upper bound, a value with no `>=` lower bound) is
  reported as unparseable rather than skipped, so a malformed pair cannot hide. **Renovate produces
  exactly this mismatch by construction** — its built-in npm manager parses the key as an opaque dep
  name and cannot rewrite it. `scripts/check-override-consistency.mjs` runs on pull requests and fails
  a mismatched pair by name, so a half-remediation cannot merge even though it appears correct. Adding
  a custom Renovate manager does not fix this (the file is already managed; a second manager
  double-manages it) — the guard is the answer.

  One more trap the same file records: `overrides` live in **`pnpm-workspace.yaml`, not
  `package.json`'s `pnpm` field**, because pnpm 11 stopped reading that field and only warns. That
  warning is a security event, not cosmetics — every override exists to force a vulnerable transitive
  dependency to a patched version, so ignoring them re-admits all of them at once and turns the `sast`
  gate red (or ships the vulnerable versions if the gate's view differs). If a future pnpm bump warns
  about ignored keys, **migrate them**.

- **Remediate, do not re-date.** Deleting or extending an `expiry` converts a time-box into a
  permanent suppression. The legitimate exception — no published fix exists — requires the evidence
  written into the `justification`. Check npm/crates/PyPI before assuming: on feature 057 both
  "needs an acceptance" advisories turned out to have published fixes.

  The committed file also records the inverse lesson: **a time-boxed acceptance can be discharged by a
  route its own justification did not anticipate.** The `image-size` entries were written as
  "re-evaluate when `image-size` publishes 2.0.3 AND metro widens its range"; 2.0.3 never shipped, and
  instead a Renovate lockfile-maintenance bump of `metro` dropped `image-size` from the tree entirely,
  so the advisories disappeared with no config change and no human in the loop. The entries were
  re-checked and deleted rather than renewed at expiry. A suppression that matches nothing only shows
  as `UNMATCHED` in a normal run's report-only output (the weekly run cannot flag it for SAST — see
  above), and deleting it means a regression re-blocks — which
  is the convention this file follows everywhere.

- **`mcm-auth-before-authz` firing on a service-layer function is a false positive you must NOT "fix"
  by adding the guard — the correct response is a file-pinned allowlist entry.** The rule's structural
  limit (a guard textually earlier in the same function) means it cannot see authorization performed in
  a wrapper/HOF. Pushing a `requireMcUser` call down into a service-layer reader or writer would
  contradict [role enforcement is a layer](../gotchas/role-enforcement-is-a-layer.md) — the invariant
  that exists precisely to prevent a per-call-site check. The committed entries therefore pin the
  pattern to **specific files** (`backup-snapshot-reader.ts`, `backup-restore-writer.ts`,
  `account-deletion.ts`), each with its residual risk stated rather than implied: a *new* unguarded
  upstream client anywhere else still fails the gate. That pinning is the whole reason a file-scoped
  `locationPattern` is the right shape here, and the entries record which route layer performs the check.

- **`p/secrets` stays off.** `secret-scan.mjs` is the sole owner of credential detection (FR-006).
  Do not double-gate with Semgrep's `p/secrets` ruleset. It is absent from
  `security/sast/semgrep.yaml` by design, and Semgrep runs with `--metrics=off
  --disable-version-check` so telemetry stays off by configuration rather than by network policy.

- **A red gate labelled `TRANSPORT/SERVICE ERROR` is a scanner outage, not a finding — re-run it.**
  Three of the four scanners reach a third party over the network: `pip-audit` queries **osv.dev**,
  `cargo-audit` fetches the **RustSec advisory DB**, and `pnpm audit` queries the **npm registry**
  advisory endpoint. Any of them can fail for a reason unrelated to this repository. Since item #449
  `sast-scan.mjs` classifies failures against a narrow `TRANSIENT_SIGNATURES` list (socket errors,
  HTTP 429/50x, DNS failures, git fetch failures) and re-attempts **3 times with exponential backoff
  (2 s, 4 s)** before issuing a verdict. What you see when it fires:
  ```
  [sast-scan] [pip-audit] transient transport/service failure on attempt 1/3 — retrying in 2000ms.
              This is NOT a security finding. Cause: …
  ```
  and when all attempts are exhausted:
  ```
  [pip-audit] TRANSPORT/SERVICE ERROR — the advisory service could not be reached, so this is NOT a
  security finding and nothing was detected in this repository. Failed all 3 attempt(s) over 6.0s of
  backoff and did not recover. Failing closed: a scanner that could not run must never report clean.
  ```
  Three properties are deliberate and must not be simplified away:
  - **Fail-closed is preserved.** After retries are exhausted the job still fails. Item #449 was
    about not failing on the first blip, never about tolerating a scanner that cannot run.
  - **The classification is deliberately narrow, and every signature is anchored.** A finding's own
    title often contains "error", "timeout" or even "Service Unavailable"; only signatures that can
    only originate below the scanner's own logic are listed. The HTTP-status forms require the
    **status code** next to the phrase (item #495) and `Read timed out` requires its terminating
    period (item #499) precisely because the bare forms match advisory titles. An unrecognised
    failure is treated as real and fails immediately — so a genuine red is not delayed by three
    identical tracebacks. `scripts/__tests__/sast-scan-retry.guard.test.mjs` pins both directions.
  - **The mechanism is shared, not copied.** Since item #495 the classifier and retry driver live in
    `scripts/lib/scanner-retry.mjs`, used by both `sast-scan.mjs` and `infra-image-scan.mjs` (Trivy's
    vulnerability-DB fetch). The hard part is the signature list, and a signature learned from one
    scanner's outage is the one the other needs next. That module also owns `readTail`, because
    truncating a scanner's output from the head hides the HTTP status that names the remedy.

  See `docs/runbooks/sast-scanning.md` § "When the gate goes red and NO finding was involved" for
  the full measured incident (run 3328, 2026-09-13) that produced this.

- **No caching yet.** `actions/cache` is not mirrored on the self-hosted runner, so cargo-audit is
  compiled fresh each CI run (~2–3 min). A monthly-keyed cache of `~/.cargo/bin/cargo-audit` and
  `~/.cargo/advisory-db` is a future optimization. `cargo-audit` is installed `--locked --version`
  pinned, because `--locked` alone locks its dependencies, not the tool that decides whether a Rust
  advisory blocks a merge.

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

  `sast-scan.mjs` groups Semgrep's `errors[]` by rule into `scanners[].blindedRules`, and the gate
  prints a `RULES THAT COULD NOT RUN` section listing each blinded rule with its error and file
  counts; any `UNMATCHED` entry whose rule appears there is annotated `↳ this rule could not run`.
  This is advisory and never moves the exit code — these rules error on every run, and a
  gate that goes red on a standing condition stops being read. Attribution has to read the error
  **message** as well as the structured `rule_id`: tail-pinned semgrep 1.169.0 populates `rule_id`
  on an internal matching error but not on a `PartialParsing` one, where the rule name appears only
  in prose — 36 errors versus 3 on the run that prompted the fix. The replacement coverage is
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

- **On a pull request, only the CHANGED targets are scanned — a rule cannot fire on a file that was
  never handed to Semgrep.** `--scope changed` builds an explicit target list from
  `git diff --name-only` against the PR base, filtered by `isScanTarget()`; the
  `security/sast/.semgrepignore` exclusions are re-applied by hand because an explicit target
  bypasses Semgrep's `--exclude`. A rule's own `paths:` cannot widen what a PR is gated on.

  Two consequences of that construction, both of which look like a clean PR. First, **an empty target
  list is a legitimate no-op, not an error**: with no changed code files, Semgrep is skipped, an empty
  native report is emitted (`skipped: 'no changed code files'`), and SCA still runs full. Second, and
  the trap, **if the `git diff` against the base fails the changed set is empty too** — the
  orchestrator warns (`git diff vs <base> failed — scanning changed set is empty`) and proceeds, so
  Semgrep scans nothing and the PR's `sast` job is green having examined no code. That is why the CI
  job fetches the PR base ref (`git fetch --no-tags --depth=200 origin "$BASE_REF"`) before the scan:
  the diff needs the ref to exist. A green PR whose log carries that warning has not been gated.

- **Workflow YAML was not a scan target on pull requests until item #224.** Before that, workflow
  YAML was absent from that list, so a `curl … | sh` added to a workflow on a PR
  was gated on nothing and first appeared on the post-merge full scan. Both
  `.forgejo/workflows/*.y[a]ml` and `.github/workflows/*.y[a]ml` are now included. The scope was
  widened deliberately — not every `.yml` tree-wide, which would drag compose files, Komodo syncs,
  and the security config tree into a scan against packs written for TS/JS/Python code.

- **Dockerfiles were the same defect a second time, and the response is now a standing blocking
  guard rather than a third comment.** `--scope changed` matches code extensions and the two workflow
  trees; a Dockerfile has **no extension**, so PR #422's new Dockerfile was handed to nothing, its
  `guardrails / sast` was a real passing run, and the post-merge full scan reddened `main` on
  `dockerfile.security.missing-user-entrypoint` until an accepted-risk entry landed (item #426).
  `DOCKERFILE_PATH_RE` now admits Dockerfile spellings (`Dockerfile`, `Dockerfile.prod`,
  `toolchain.Dockerfile`) without substring-matching `.dockerignore` or prose.

  Because that class of bug is invisible from a green gate, the gate itself now reports it:
  `GATE-SCOPE ASYMMETRY (blocking on push, invisible on a pull request)` lists blocking SAST findings
  whose paths are not scan targets, and — unlike every other diagnostic section — **it moves the exit
  code** (its own blocking path, separate from the ordinary "this code is wrong" failure). Four
  properties matter:
  - It counts **suppressed** findings too, not just un-allowlisted ones. The minio Dockerfile case was
    an accepted risk with an allowlist entry, so the gate was green and the asymmetry was invisible
    *because* everything looked fine.
  - It runs only on a `--scope full` report; `generatedAtScope` is therefore **required**, and a
    report missing or carrying an unknown value is a hard `GateError` rather than a silent skip.
  - SCA findings are excluded — the three audit scanners ignore `--scope` entirely and always run over
    the whole lockfile set, so they cannot be scope-asymmetric.
  - The remedy it prints is to widen the changed-scope filter (`CODE_EXT_RE` / `WORKFLOW_PATH_RE` /
    `DOCKERFILE_PATH_RE` in `scripts/sast-scan.mjs`), **not** to add an allowlist entry — an allowlist
    entry is exactly what concealed item #426 for a merge cycle.

  The whole PR-visible surface was then enumerated once, by testing every full-scan finding's path
  against `isScanTarget`. After Dockerfiles were added, **zero blocking findings sit on a file class a
  pull request cannot see**. Two classes remain deliberately invisible and are recorded rather than
  closed: `.json` (e.g. `renovate.json`) and non-workflow `.yaml` (e.g. `pnpm-workspace.yaml`), which
  between them carry 22 findings that are *all* Medium and so report-only on a push too. That residual
  is a **snapshot of today's rule set** — if a pack update promotes one of those rules to ERROR, the
  gap reopens silently and the enumeration method must be re-run.

- **`--test-rules` enforces fixtures; without it they were decoration for months.** The four original
  custom rules shipped with `semgrep --test` fixtures, but `--test-rules` appeared in no workflow, no
  Nx target, and no script until item #224 — so the `ruleid:`/`ok:` annotations had been decoration
  in the tier that decides whether a High blocks a merge. `sast-scan.mjs --test-rules` now runs ahead
  of the scan in the CI `sast` job. It also fails on a rule with **no** fixture — `semgrep --test`
  skips unfixtured rules silently and still prints `N/N ✓` (measured: `4/4 ✓` with five rule files
  present), which is the same false assurance as a blinded rule. A code rule's fixture shares its stem
  as `<rule>.ts` / `<rule>.py`; a YAML rule's fixture must be named `<rule>.test.yml`, because a bare
  `<rule>.yaml` would be loaded as a second rule by `--config security/sast/rules/`. The Semgrep pin
  lives only in `sast-scan.mjs` (Renovate tracks it there), so the workflow step carries no second
  copy to drift.

See [CI/CD pipeline](./ci-cd-pipeline.md) for how the `sast` job sits in the
`guardrails.yml` workflow, [infra-image scanning](../runbooks/infra-image-scanning.md) for the Trivy
allowlist this one shares the expiry mechanism and the retry module with,
[SAST scanning](../runbooks/sast-scanning.md) for the operator triage playbook when `main` goes red on
an advisory you never touched, and [Renovate](../runbooks/renovate.md) for the lockfile-refresh
schedule that clears most `OVERRIDE LEVERS` advice. `security/sast/README.md` is the full config
reference and the home of the custom MCM rule definitions.
