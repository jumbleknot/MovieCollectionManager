# SAST & SCA Static Security Scanning (Semgrep + audit tools) — feature 033

Config-as-code **Static** Application Security Testing (SAST) and **Software Composition Analysis** (SCA),
all **keyless** (no SaaS, no account, no new CI secret). Where DAST (feature 031) exercises the *running*
app over HTTP, this scans the source and the dependency graph *at rest*. Four scanners, one normalized
severity scale, one allowlist-as-baseline, one blocking `sast` CI job.

| Kind | Scanner | Surface | Invocation |
|---|---|---|---|
| SAST | **Semgrep** (OSS) | first-party TS/JS tree (BFF + full frontend) + Python agent layer | `uvx semgrep@<pin> scan` |
| SCA | **cargo audit** | Rust deps (root `Cargo.lock`) | `cargo audit --json` |
| SCA | **pnpm audit** | JS deps (root `pnpm-lock.yaml`) | `pnpm audit --json` |
| SCA | **pip-audit** | Python deps (`agents/movie-assistant/uv.lock`) | `uvx pip-audit` over a `uv export` |

Rust *code* is out of Semgrep scope (clippy via `pnpm nx lint mc-service` already covers Rust patterns);
Rust participates only through `cargo audit` (deps). `p/secrets` is **never** enabled — the existing
`secret-scan` gate remains the sole owner of credential detection (FR-006).

## Normalized severity scale

All four scanners' native severities map onto one **Critical / High / Medium / Low** scale via
[`severity-map.yaml`](./severity-map.yaml) (applied by the orchestrator, not the gate). The gate fails on
any un-allowlisted **High/Critical** finding that is *blocking*; Medium/Low are warnings.

`blocking = severity ∈ {High, Critical} AND (kind == sast OR scope == runtime)` — a High/Critical advisory
in a **runtime** dependency blocks; the same advisory in a **dev/test/build-only** dependency is downgraded
to a non-blocking warning (FR-021). Dependency scope is computed deterministically per ecosystem
(`cargo tree --edges no-dev`, `pnpm audit --prod`, `uv export --no-dev`).

## Custom MCM rules

Project-specific invariants live under [`rules/`](./rules/), each with `semgrep --test` fixtures (FR-019)
run by `node scripts/sast-scan.mjs --test-rules` (wired into the `sast` CI job, ahead of the scan):

| Rule | Severity | Enforces |
|---|---|---|
| `mcm-no-console-in-bff` | WARNING → Medium (warn) | no direct `console.*` in `src/bff-server/**` or `bff-api/**` |
| `mcm-no-token-logging` | ERROR → High (block) | no logging of a raw token/JWT/`authorization`/session id/email in server code |
| `mcm-auth-before-authz` | ERROR → High (block) | a BFF route handler must not reach an upstream call without a preceding `requireAuth`/`requireMcUser` |
| `mcm-no-jwt-payload-tracing` | ERROR → High (block) | no logging/tracing of a decoded JWT payload on the TS/JS + Python surfaces |
| `mcm-ci-curl-pipe-shell` | ERROR → High (block) | no `curl … \| sh` in a workflow step from a URL outside that rule's accepted, pinned list |

### A rule that goes BLIND reads exactly like a remediated one

`mcm-ci-curl-pipe-shell` exists because the community rule that covered the same ground had silently
stopped being able to see this repository. `p/owasp-top-ten` ships
`yaml.github-actions.security.gha-curl-pipe-shell`, which re-parses a step's `run:` block as Bash via
`metavariable-pattern` — and nearly every run-step here is wrapped in the ci-log-step heredoc
(feature 042), which that sub-parser cannot read. It abandons the block instead of matching inside it.

Measured on `main` 2026-09-06 with the pinned `semgrep@1.169.0` and this repo's own `semgrep.yaml`:
**36 errors, every one attributed to that rule, and 0 findings from it** — while six `curl … | sh`
lines sat in the workflows unexamined. Its allowlist entry was reported as `UNMATCHED`, whose wording
offered exactly two explanations, both of which said the code was fine.

Two consequences are now permanent:

- **The replacement is text-level.** `pattern-regex` / `pattern-not-regex`, never
  `metavariable-pattern`, so no sub-parser is invoked and the heredoc is irrelevant.
  `scripts/__tests__/ci-curl-pipe-shell-rule.guard.test.mjs` fails if anyone "improves" that back.
- **The gate now reads the scanner's own errors.** `sast-scan.mjs` groups Semgrep's `errors[]` by
  rule into `scanners[].blindedRules`, and `check-sast-findings.mjs` prints `RULES THAT COULD NOT
  RUN` — annotating any `UNMATCHED` entry whose rule is in that list, so the third cause is named
  rather than left off the list. Advisory: it never moves the exit code.

The accepted installers are named in the **rule**, not in `allowlist.yaml`, because an allowlist entry
keys on `path:line` — a file wildcard would suppress a *new* `curl | sh` anywhere in that workflow.
Adding an installer means editing `pattern-not-regex`, and the comment beside it is the decision.

A third consequence, less obvious: `--scope changed` (what CI runs on a **pull request**) hands
Semgrep an explicit target list, and workflow YAML was not on it — so this rule, and the blinded one
before it, could only ever fire on the post-merge full scan. `isScanTarget()` now admits
`.forgejo/workflows/*.y[a]ml` and `.github/workflows/*.y[a]ml`, and nothing else new: widening to
every `.yml` would drag compose files, Komodo syncs and this config tree into a PR-scoped scan
against packs written for TS/JS/Python. The only pre-existing YAML findings this exposes on a PR are
two `gha-workflow-env-secret` hits (WARNING → Medium → non-blocking).

> **The fixtures were run by nothing until item #224.** They shipped with feature 033, and
> `semgrep --test` appeared in no workflow, no Nx target and no script — four rules' `ruleid:`/`ok:`
> annotations had been decoration for months, in the tier that decides whether a High blocks a merge.
> `--test-rules` runs them, and *also* fails on a rule with no fixture: `semgrep --test` skips those
> silently and still reports `N/N ✓`, which is the same false assurance as a blinded rule. A YAML
> rule's fixture is named `<rule>.test.yml` — a bare `<rule>.yaml` would be loaded as a rule by
> `--config security/sast/rules/`.

> `mcm-no-jwt-payload-tracing` covers **TS/JS + Python only**. mc-service (Rust) is out of Semgrep scope,
> so its no-JWT-logging invariant stays owned by `cargo clippy` + code review (documented gap).

## How to run

> Full procedure (local run, CI job, toolchain/cache notes, triage) →
> [docs/runbooks/sast-scanning.md](../../docs/runbooks/sast-scanning.md).

No application stack is required — this is a static scan. Prerequisites: Node ≥ 20, `uv`/`uvx`, a Rust
toolchain with `cargo-audit`, and pnpm (all provisioned in CI; install locally as needed).

```bash
pnpm nx sast infrastructure-as-code        # or: node scripts/sast-scan.mjs --scope full
```

Reports land in `security/sast/reports/` (gitignored).

## Reports

Each run writes to `security/sast/reports/` (gitignored):

| File | Purpose |
|---|---|
| `findings.json` | **gate input** — normalized report (`check-sast-findings.mjs` reads this) |
| `findings.sarif` | portable SARIF interchange |
| `summary.txt` | human summary grouped by normalized severity + scanner |
| `<scanner>-native.json` | each scanner's raw output, secret-scrubbed, for triage |

## Triage / allowlist workflow

A **blocking High/Critical** finding fails the CI gate. To resolve one you either **fix it** or, if it is a
false positive / accepted risk, **triage it** into [`allowlist.yaml`](./allowlist.yaml) with all required
fields (a blank `justification` or `addedBy` is a **gate error**):

```yaml
- scanner: "semgrep"                       # semgrep | cargo-audit | pnpm-audit | pip-audit — must match
  id: "mcm-no-token-logging"               # EXACT rule id (Semgrep check_id) or advisory id (RUSTSEC-*/GHSA-*/CVE-*/PYSEC-*)
  locationPattern: "src/bff-server/foo\\.ts:.*"   # REGEX vs Finding.location — 'path:line' (FORWARD slashes) or 'package@version'
  justification: "False positive: the logged value is a request id, not a token."   # required, non-empty
  addedBy: "steve"                         # required, non-empty — who triaged
  # expiry: "2026-12-31"                    # optional ISO YYYY-MM-DD (see below)
```

**Field rules** (a missing/blank `justification`/`addedBy` or an invalid `locationPattern` regex is a
**gate error** — exit 2):

- **Match key** = `scanner` equal **AND** `id` equal **AND** `locationPattern` matches the finding's
  `location`. Scope `locationPattern` narrowly — anchor to the file (SAST) or package (SCA); avoid a
  blanket `.*`. Paths are normalized to **forward slashes** so one pattern works on the Windows dev host
  and the Linux CI runner.
- **`expiry`** (optional, ISO `YYYY-MM-DD`): while absent or **today-or-later**, the entry suppresses.
  Once the date is **past**, the entry stops suppressing and the finding **blocks again** — use it to
  force re-review of a time-boxed accepted risk (e.g. "accepted until the upstream fix ships").
  **You will hear about it 14 days before that happens** — see below.

### When you will hear about an expiry — the 14-day warning window

Expiry used to be **binary**: full suppression until the date, then a hard failure the next morning,
usually surfacing on somebody else's unrelated pull request. There is now a tier in between
(feature 057). If you add an entry with an `expiry`, this is what happens to it:

| State | What the gate does |
| --- | --- |
| **Active** — more than 14 days out | Suppresses, silently. |
| **Expiring soon** — **14 days or fewer** out, *including the expiry day itself* | **Still suppresses, and the exit code does not move.** Listed under `EXPIRING SOON` with its id, date, days remaining and `addedBy`. |
| **Expired** — the date has passed | Stops suppressing; the finding blocks. The failure **explains itself**: "this finding was suppressed until `<date>` by an entry added by `<addedBy>`" — so nobody has to open this file to understand a new red. |

Both window boundaries are **inclusive**: exactly 14 days out is already *expiring*, and an entry
suppresses through the whole of its final day.

**Unmatched entries are reported too.** An entry that suppressed nothing this run is listed under
`UNMATCHED ENTRIES` — it is either stale (the finding was genuinely remediated and the entry was left
behind) or, the case that actually bit us, its scanner changed identifier namespace. The
aiohttp/cryptography entries re-blocked *early* when pip-audit began reporting the same advisories
under PYSEC aliases instead of CVE ids: an entry keyed on an exact advisory id **does not expire, it
just quietly matches nothing**. This is only evaluated for scanners that produced at least one
finding in the run, so a skipped, failed or clean scanner never flags its whole entry set.

**Where you actually see it.** On a normal gate run these three sections are printed and change
nothing — no pull request is ever newly blocked by them. The signal that is allowed to fail is the
dedicated mode, which runs **weekly** (Friday) in `infra-image-scan` over both allowlists and is
deliberately **not** run on pull requests:

```bash
node scripts/check-sast-findings.mjs --check-expiring        # exit 1 on any expiring/expired/unmatched entry
node scripts/check-infra-image-findings.mjs --check-expiring
```

The window is **14 days**, defined in exactly one place — `WARNING_WINDOW_DAYS` in
[`scripts/allowlist-expiry.mjs`](../../scripts/allowlist-expiry.mjs) — and shared by both gates.
Fourteen was chosen over 21 or 28 on purpose: keeping entries *out* of the window most of the time is
what keeps a red check worth reading. The accepted cost is that a remediation needing its own branch
and a real build gets two weeks' notice rather than three, so **date an entry with that in mind**.
- **Suppression is gate-only**: an allowlisted finding is removed from the *failure* set but stays
  **visible** in `findings.json` / the reports and is printed as "allowlisted by …" (FR-010) — accepted
  risks remain auditable, never hidden.
- Only **blocking** findings (High/Critical that are SAST, or runtime-scope SCA) need an entry; Medium/
  Low and dev-scope findings are warnings and never fail the gate.

**Seeding a fresh baseline**: `node scripts/sast-scan.mjs --scope full --emit-allowlist` writes
`reports/allowlist.proposed.yaml` covering every current finding (TODO justifications). Triage each,
then copy the kept entries into this `allowlist.yaml`. The committed baseline (FR-012 / SC-006) makes
`main` green on day one so the gate blocks only findings introduced *after* the baseline.

Verify the gate logic anytime with `node scripts/check-sast-findings.mjs --selftest`.
