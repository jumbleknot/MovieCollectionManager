# Implementation Plan: restore the dependency-security maintenance loop

**Branch**: `057-dependency-security-loop` | **Date**: 2026-08-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/057-dependency-security-loop/spec.md`

## Summary

Four faults in one loop, fixed in dependency order: give the update bot a supported runtime, give it a
schedule it is actually awake for, teach it to see the override floors it has never been able to
reach, and give the allowlist gates a warning tier so a time-boxed acceptance stops announcing itself
by blocking everyone.

The two halves have different characters and the plan keeps them apart. Stories 1-2 are **four lines
of YAML and a corrected comment**, validated by a gate that already exists. Stories 4-5 are **new
scripts with new tests** — a shared expiry module, a check mode, and a consistency guard. Story 3 sits
between them: a dependency bump with a hard date, deliberately independent of everything else.

## Technical Context

**Language/Version**: Node.js ESM (`.mjs`), running on Node 24.14.1 in CI and ≥22.13 locally
(`engines.node`). No TypeScript — `scripts/` is plain ESM by convention.

**Primary Dependencies**: `yaml` (already a dependency of both gates); `node:test` + `node:assert`
for unit tests; Renovate 44.x as an external tool invoked via `npx` in CI; `pnpm` 11 for lockfile
resolution.

**Storage**: Flat files only — two YAML allowlists, `pnpm-workspace.yaml`, `renovate.json`, and two
Forgejo Actions workflow files. No database, no persisted state between runs. **This is load-bearing
for R2's design**: the expiry check must be stateless, which is why "unmatched for N consecutive
runs" was never a viable option.

**Testing**: Two tiers, both offline.
- `node --test scripts/__tests__/*.test.mjs` — the tooling tier, run by `guardrails.yml:147`. New
  `*.test.mjs` files are picked up by the glob automatically; **no workflow change is needed** to
  make new tests run.
- Each gate's own `--selftest` mode, run in CI immediately before its real scan
  (`guardrails.yml:328`, `infra-image-scan.yml:145`).

**Target Platform**: Forgejo Actions runners (containerized `ubuntu-latest`), and the devcontainer for
local verification.

**Project Type**: Repository tooling and CI configuration. No application code, no runtime service.

**Performance Goals**: None meaningful. The expiry classification is O(entries × findings) over files
of tens of entries; the gates already do more work than this in their matching loop.

**Constraints**:
- **No gate may newly block a pull request** (FR-021, SC-007). This is the binding constraint on the
  whole of Story 5 and dictates the `schedule`-event guard in R6.
- The expiry check must be **stateless** — see Storage above.
- `scripts/` shares code via **flat sibling imports**, not a `lib/` directory (R5).

**Scale/Scope**: 2 workflow files, 2 config files, 2 allowlists, 2 existing gate scripts modified,
2 new scripts, ~3 new test files. 8 allowlist entries and 13 overrides in scope for the new checks.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. No violations.*

| Principle | Applies? | How this plan satisfies it |
| --- | --- | --- |
| **Test-Driven Development** (NON-NEGOTIABLE) | **Yes** | Every behavioural change lands as a failing test first. Both tiers run offline, so every task can carry a real Verify RED command — no "cannot be verified locally" escapes. See *TDD viability* below. |
| **Test Type Integrity** (NON-NEGOTIABLE) | Yes | All new tests are genuine unit tests over pure functions and fixture files. Nothing here has an external dependency to mock, so the prohibited-substitution rules cannot be engaged. |
| **Behavior-Descriptive Identifiers** | Yes | New identifiers name behaviour (`allowlist-expiry.mjs`, `check-override-consistency.mjs`, `classifyExpiry`, `WARNING_WINDOW_DAYS`). No `FR-###` in any identifier; requirement provenance goes in a JSDoc comment, the one sanctioned WHAT-comment exception. |
| **Documentation** | Yes | `security/sast/README.md` gains the window (FR-028). Comments are added only where rationale is non-obvious — the engine-bump residual risk (FR-004) and the corrected schedule comment (FR-008) are both exactly that. |
| **Technology Agnosticism** | Yes | `spec.md` names no file, flag or tool in its requirements; every concrete choice lives here and in `research.md`. |
| **No Vibe Coding** | Yes | Each task cites the FR it implements. |
| Security / Auth / Logging / Backend / Frontend / Agents | **No** | This feature touches no service, no request path, no user data and no runtime logging. The Security principles govern *what the gates protect*, not the gates themselves; nothing here changes an authn/authz surface. |

**TDD viability, stated explicitly** because it is the principle most often fudged: every one of
Stories 3-5's changes is verifiable RED offline. The gate selftests take fixture strings inline, the
tooling tests take fixture files, and the consistency guard follows
`check-toolchain-consistency.mjs`'s `--dir` pattern so a test can point it at a temp directory
containing a deliberately mismatched override. Stories 1-2 are configuration, so their RED is a
different shape: `check-toolchain-consistency.mjs` fails on a bad `node-version`, and the schedule
arithmetic is asserted by a new test that parses both files and compares the trigger against the
permitted window — which fails today, on `main`, before any fix.

## Project Structure

### Documentation (this feature)

```text
specs/057-dependency-security-loop/
├── plan.md              # This file
├── spec.md              # Feature specification (3 clarifications recorded)
├── research.md          # Phase 0 — 8 findings, all measured
├── data-model.md        # Phase 1 — entity shapes and state rules
├── quickstart.md        # Phase 1 — how to validate the whole feature
├── contracts/           # Phase 1 — CLI + module contracts
│   ├── allowlist-expiry.module.md
│   ├── check-expiring.cli.md
│   └── check-override-consistency.cli.md
├── checklists/
│   └── requirements.md  # Spec quality checklist (16/16)
└── tasks.md             # Phase 2 — NOT created by /speckit-plan
```

### Source Code (repository root)

```text
.forgejo/workflows/
├── renovate.yml                        # US1: + setup-node before corepack; + engine-risk comment
│                                       # US2: + second cron; corrected schedule comment
└── infra-image-scan.yml                # US5: + --check-expiring step, guarded to schedule events

renovate.json                           # US2: schedule widened for DST
                                        # US4: + second customManager over the override map

pnpm-workspace.yaml                     # US3: fast-uri floor raised, ip-address floor added,
                                        #      minimumReleaseAgeExclude updated
pnpm-lock.yaml                          # US3: regenerated

security/
├── sast/
│   ├── allowlist.yaml                  # US3: two entries DELETED
│   └── README.md                       # US5: warning window documented
└── infra-images/allowlist.yaml         # (unchanged; gains the warning tier via its gate)

scripts/
├── allowlist-expiry.mjs                # NEW — window constant, classification, formatting
├── check-override-consistency.mjs      # NEW — the key/value lockstep guard
├── check-sast-findings.mjs             # MODIFIED — warning tier, unmatched, --check-expiring
├── check-infra-image-findings.mjs      # MODIFIED — identically
└── __tests__/
    ├── allowlist-expiry.test.mjs       # NEW
    ├── check-override-consistency.test.mjs  # NEW
    ├── renovate-workflow.guard.test.mjs     # NEW — the US1/US2 RED
    └── check-sast-findings.test.mjs    # EXTENDED
```

**Structure Decision**: No new directory is created. `scripts/` is flat — sharing happens through
sibling imports (`ci-digest-redact.mjs`, `openwiki-policy.mjs` and `ci-status.mjs` are each imported
by three or more scripts) and there is no `scripts/lib/`. `allowlist-expiry.mjs` follows that
convention. Tests live in the existing `scripts/__tests__/` and are discovered by the glob already
wired into `guardrails.yml`.

## Mechanism

### Stories 1-2 — configuration, validated by gates that already exist

```yaml
# renovate.yml
schedule:
  - cron: '0 3 * * *' # nightly — schedule-exempt security PRs land promptly
  - cron: '0 7 * * 5' # Friday 03:00 America/New_York — the renovate.json window for routine updates

steps:
  - uses: actions/setup-node@<sha> # v4
    with: { node-version: 24.14.1 }
  - name: Enable pnpm (corepack …)   # must come AFTER the line above
```

```jsonc
// renovate.json — widened so the UTC cron lands inside the window in both EDT and EST
"schedule": ["* 2-4 * * 5"],
```

`check-toolchain-consistency.mjs` already scans `.forgejo/workflows` for `node-version:` pins against
`engines.node` (`>=22.13`), so the new pin is gated the moment it is written. The schedule arithmetic
has no existing gate, which is why the plan adds one — see below.

### The schedule guard — turning a comment into a check

The bug in #153 was a **comment asserting a relationship that did not hold** ("matches the
renovate.json schedule window"). Correcting the prose fixes today and prevents nothing. So the plan
adds `renovate-workflow.guard.test.mjs`, which parses both files, converts each cron trigger to UTC,
converts the permitted window from `America/New_York` to UTC for both DST offsets, and asserts at
least one trigger falls inside the window **year-round**.

That test fails on `main` today — which is what makes Stories 1-2 TDD-able rather than "edit YAML and
hope" — and it is the only artifact that stops the two files silently drifting apart again.

### Story 3 — the remediation

Raise `fast-uri`'s floor (both halves, per the R3 invariant), add an `ip-address` floor, update the
**existing** `minimumReleaseAgeExclude` entry for `fast-uri@3.1.4`, refresh the lockfile, and
**delete** both allowlist entries. Verified by `sast-scan.mjs` + `check-sast-findings.mjs` showing the
advisories as neither blocking nor suppressed, plus a build and the web E2E baseline (FR-013 — these
are toolchain transitives, so breakage surfaces at build time, not in unit tests).

### Story 4 — two matchStrings, one lockstep

A second `customManager` over `pnpm-workspace.yaml` with **two `matchStrings`**: one capturing the
version inside the vulnerable-range key, one capturing the version inside the patched value, both
emitting the same `depName` and the `npm` datasource. Renovate substitutes a captured `currentValue`
**in place**, so capturing the bare version (`3.1.4`, not `>=3.1.4 <4`) makes the rewrite a character
substitution rather than range arithmetic — and two matches for one dependency move both halves in a
single PR.

`check-override-consistency.mjs` then enforces what R3 measured: for every override whose key carries
an `@<range>` suffix, the key's exclusive upper bound must equal the value's inclusive lower bound.
**Ten of ten entries satisfy this today**, so the guard is green on arrival and fails only on a real
half-bump. Plain pins without a key half (`react-dom`, `postcss`, `@expo/dom-webview`) are out of
scope for the rule — treating them as violations is the single most likely way to get this wrong.

The pairing mirrors the existing nx manager + `check-toolchain-consistency.mjs`, for the same reason:
a manager proposes, a guard proves the proposal is whole.

### Story 5 — one module, two gates, one scheduled check

```text
scripts/allowlist-expiry.mjs
  WARNING_WINDOW_DAYS = 14          ← the single definition (FR-024)
  classifyExpiry(entry, today)      → 'active' | 'expiring' | 'expired'
  formatExpiring / formatExpired / formatUnmatched
```

Each gate keeps its own entry compilation (their shapes differ: `{scanner, id, locationPattern}` vs
`{image, id}`) and passes a normalized view in. Normal runs print the new sections and **do not change
their exit code**. `--check-expiring` exits non-zero on any expiring, expired or unmatched entry, and
runs in `infra-image-scan.yml` under `if: github.event_name == 'schedule'` — the guard that keeps
FR-021/SC-007 true, since that job also serves path-gated `pull_request` runs.

Unmatched is evaluated **only for scanners that produced at least one finding** (clarification Q2), so
a skipped, failed or clean scanner never flags its whole entry set.

**The failure is announced with no new plumbing**: that job already calls `ci-failure-digest.mjs` on
failure (lines 86-95, 192-201).

## Verification

| Claim | Standard |
| --- | --- |
| The bot runs on a supported engine | A dispatched run exits 0 with no `EBADENGINE` and no "Unsupported node environment" |
| The schedule actually opens | `renovate-workflow.guard.test.mjs` passes; then a `dryRun=true` dispatch lists branches it *would* open; then item #29's "Awaiting Schedule" groups become real PRs |
| The manager extracts | A dry run reports a **non-zero** dependency count for `pnpm-workspace.yaml`, against a measured baseline of **zero**. Config passes `renovate-config-validator` first |
| Both override halves move together | The guard fails on a deliberately mismatched fixture and passes on the real map (10/10 today) |
| The advisories are cleared | `sast-scan.mjs` + `check-sast-findings.mjs`: neither advisory blocking **nor** suppressed; both entries gone from the file |
| The floors did not break the build | A build plus the web E2E baseline — not `nx test` (FR-013) |
| The warning tier changes no exit code | Gate selftests: an entry inside the window still suppresses and still exits 0 |
| No PR is newly blocked | The `--check-expiring` step does not appear in a `pull_request` run's step list |
| The signal fires when predicted | First run after merge **green**; first red **Friday 2026-08-28**, naming the `image-size` pair (research R8) |

## Sequencing

Natural dependency order, as decided during brainstorming: bot → gap → warning tier. Two constraints
override pure ordering:

1. **Story 3 is independent of everything.** Its 2026-08-31 date is external, so it must not be able
   to be blocked by Story 4's dry-run outcome or Story 5's size. This is why the clarification split
   the two apart.
2. **Story 4's guard can land before its manager.** The guard is green on today's map, so it is safe
   to add on its own — and doing so means the manager arrives into a repository that already refuses
   half-bumps, rather than the other way around.

## Risks

| Risk | Mitigation |
| --- | --- |
| The custom manager silently extracts nothing — the v41 `fileMatch`→`managerFilePatterns` trap the config file itself documents | FR-014 makes non-zero extraction a *measured* precondition; FR-019 is the documented fallback. Never inferred from the config's presence |
| The consistency guard fires on the three legitimate plain pins | The rule is scoped to keys carrying an `@<range>` suffix; a test asserts all three plain pins pass |
| `--check-expiring` leaks onto the PR trigger and blocks merges | The `schedule` event guard, plus a verification step that reads a real PR run's step list rather than trusting the `if:` |
| The weekly check becomes permanently red and stops being read | The scanner-produced-findings guard (Q2) removes the main false-alarm class; the 14-day window (Q3) was chosen for quietness over lead time for exactly this reason |
| A raised floor breaks the build in a way unit tests miss | FR-013 makes build + web E2E baseline the standard, since these are JS-toolchain transitives |
| Fixing the schedule releases eight deferred update groups at once | `prConcurrentLimit: 5` / `prHourlyLimit: 2` already throttle this; the dry run previews the set before it is live |
| The comment is corrected and the files drift apart again later | The schedule guard test, not the comment, is the durable artifact |

## Complexity Tracking

No Constitution Check violations. Nothing to justify.
