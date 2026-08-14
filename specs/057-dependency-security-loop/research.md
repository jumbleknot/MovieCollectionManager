# Phase 0 research: restore the dependency-security maintenance loop

**Feature**: `057-dependency-security-loop` · **Date**: 2026-08-13 · **Spec**: [spec.md](./spec.md)

Every finding below was **measured against the working tree**, not recalled. Where a claim in a
backlog item turned out to be wrong, the correction is recorded with the command that produced it —
the point of this file is that the plan rests on facts rather than on the items' prose.

---

## R1 — Where the new Node pin must sit, and what already validates it

**Decision**: Add `actions/setup-node@v4` (commit-pinned) at `node-version: 24.14.1` immediately
before the `corepack enable` step in `.forgejo/workflows/renovate.yml`.

**Rationale**: Corepack is provisioned *from whichever Node is on PATH*. The job currently enables
corepack at line 64 with only the container's bundled `v22.23.2` available, so placing the install
after it would leave corepack bound to the wrong runtime even once Node 24 exists.

**Already-enforced, and this is the useful part**: `scripts/check-toolchain-consistency.mjs` scans
`.forgejo/workflows` for every `node-version:` pin and fails when one does not satisfy the repo's
declared floor (`engines.node` = `>=22.13` in the root `package.json`). It runs in the `naming` job
of `guardrails.yml` at lines 133-134, selftest first. So the new pin is validated by an existing gate
the moment it is added — no new enforcement is needed for FR-001/FR-002, and a typo'd version fails
before merge.

**Alternatives considered**:

- *Pin Renovate back to an older 44.x.* Rejected — the engine requirement is legitimate and every
  other job in this repository already runs Node 24. Pinning back preserves the fault.
- *Bump the container image.* Rejected — far wider blast radius than one step, and it diverges from
  the `actions/setup-node` convention the other five workflows use.

**Residual risk to record in the pin comment (FR-004)**: the existing block at `renovate.yml:87-99`
argues only about *config semantics* — that a major could change how `renovate.json` is read. It does
not mention that a minor/patch inside the pinned major can raise `engines`, which is exactly what
44.14.12 did. That sentence is the deliverable, not a nicety.

---

## R2 — The schedule arithmetic, and the sibling that got it right

**Decision**: Add a second cron `0 7 * * 5` alongside the existing nightly `0 3 * * *`, and widen
`renovate.json`'s `schedule` from `["* 3 * * 5"]` to `["* 2-4 * * 5"]`.

**Rationale**: Measured disjointness — `renovate.yml:34` fires at 03:00 UTC; `renovate.json:16-17`
permits branch creation only during `* 3 * * 5` in `America/New_York`, i.e. 07:00-07:59 UTC on
Friday. 03:00 UTC is 23:00 Thursday in New York. The process is never awake inside its own window.

`infra-image-scan.yml:27` already uses `0 7 * * 5` for the identical "Friday ~3 AM ET" intent, and
its own comment at line 26 records why the widening is needed: *"Actions cron is UTC-only and does
NOT observe DST, so this drifts ±1h across the DST boundary."* `0 7 * * 5` is 03:00 EDT but 02:00
EST; a one-hour window catches only half the year. `* 2-4 * * 5` covers both.

**Why add rather than move**: the nightly run is what keeps schedule-exempt security PRs prompt.
`vulnerabilityAlerts` inherits an empty schedule from its preset, which is why security PRs (#121,
#141) kept landing while every routine update deferred — that is the behaviour that masked this fault
for four weeks, and it must be preserved.

**Alternatives considered**:

- *Drop the `schedule` key entirely.* Rejected — the weekly cadence is deliberate; removing it would
  restore per-push churn the schedule was introduced to control.
- *Move the nightly cron to 07:00.* Rejected — it would delay security PRs by up to 24 hours to fix a
  routine-update problem.

---

## R3 — The override map's structure, and the invariant the new guard enforces

**Decision**: The consistency guard's rule is **the vulnerable-range key's exclusive upper bound must
equal the patched value's inclusive lower bound**, applied only to entries whose key carries an
`@<range>` suffix.

**Rationale — verified, not assumed.** Parsing `pnpm-workspace.yaml` and comparing the two halves of
every override:

| Entry shape | Count | Result |
| --- | --- | --- |
| `name@<vulnerable-range>: '<patched-range>'` | **10** | all agree — 0 mismatches |
| `name: <plain pin>` (`react-dom`, `postcss`, `@expo/dom-webview`) | 3 | no key half; out of the rule's scope |

Worked examples: `fast-uri@<3.1.4: '>=3.1.4 <4'` → key upper `3.1.4`, value lower `3.1.4`. ✓
`js-yaml@>=3.0.0 <3.15.1: '>=3.15.1 <4'` → `3.15.1` / `3.15.1`. ✓ Ten for ten.

Two consequences the plan depends on:

1. **The guard is green on today's map**, so it can be added without a remediation prerequisite. It
   fails only when someone (or the bot) moves one half without the other.
2. **`postcss: '>=8.5.18'` is a floor with no key half.** The rule must key off the `@` suffix, or it
   would report a false mismatch on a legitimate entry. This is the single most likely way to get the
   guard wrong.

**Alternatives considered**:

- *Extend `check-toolchain-consistency.mjs`.* Rejected — different domain (security overrides vs
  toolchain pins), and the constitution's behaviour-descriptive-identifier rule pushes toward a name
  that says what it guards. A sibling script matching that file's proven shape is the better fit.
- *Enforce that every override has a key half.* Rejected — three legitimate plain pins exist and are
  not security floors; this would be a guard that fails on correct input.

---

## R4 — Whether a Renovate custom manager can reach the override map

**Decision**: A regex `customManager` with **two `matchStrings` over the same file** — one capturing
the version inside the vulnerable-range key, one capturing the version inside the patched value —
both emitting the same `depName` and `npm` datasource, so a bump rewrites **both halves in one PR**.

**Rationale**: Renovate regex managers substitute the captured `currentValue` **in place**, so
capturing the bare version (`3.1.4`) rather than the whole range (`>=3.1.4 <4`) sidesteps
range-rewriting entirely — Renovate writes the new version into the same character span, and
`>=3.1.4 <4` becomes `>=3.1.5 <4` with no range arithmetic. Two matches for the same dependency and
the same target version keep the key and value in lockstep, which is what makes R3's guard pass on a
bot-authored PR instead of failing on every one.

**The pattern is already proven here.** `renovate.json:37-53` carries a regex `customManager` keeping
`nx.json`'s `installation.version` in lockstep with the `nx` devDependency — added precisely because
a half-bump (PR #141 raised one and left the other) would have silently disarmed a security update.
This feature is a second instance of that pattern applied to a second lockstep pair, not a novel
mechanism.

**Why this still needs proof before merge (FR-014)**: the same file records the trap —
*"v41 renamed customManagers' `fileMatch` to `managerFilePatterns`, and a config using the wrong key
does not fail loudly, it silently manages nothing."* A manager that extracts zero is
indistinguishable from today's behaviour. The dry run is therefore not ceremony; it is the only thing
that separates the two outcomes. Baseline to beat: **zero** dependencies extracted from
`pnpm-workspace.yaml` today.

> **CORRECTION — 2026-08-13 (feature 058 / item #184).** The "baseline to beat: **zero**" above is
> **false**, and it was inherited from item #152 rather than measured. Run **1704** (2026-08-13, head
> `6afc2c8`) extracted **twelve** dependencies from `pnpm-workspace.yaml` via the **built-in npm
> manager**. There is no zero baseline, so a second manager over that file would double-manage it —
> which is why feature 057 ultimately did not merge one, and why `renovate.json` records that as a
> measured decision rather than an omission. The conclusion that no floor is ever raised automatically
> still holds, for a different reason: the bot proposes only when the range fails to satisfy the newest
> version, and it reasons about the manifest range rather than the lockfile resolution. Left standing
> as the record of what was believed at the time — see
> `specs/058-dependency-refresh-loop/research.md` R6.

**Alternatives considered**:

- *Capture the whole range as `currentValue`.* Rejected — relies on Renovate's range-replacement
  behaviour for compound ranges, which is far less predictable than in-place version substitution.
- *One manager on the value half only.* Rejected — it produces exactly the half-bump R3's guard
  exists to catch, so every bot PR would be red by construction.
- *Visibility only (register the dep, never rewrite).* Considered and rejected by clarification Q1;
  recorded here because it remains the natural fallback shape if FR-019 is triggered.

**Fallback (FR-019)**: if a dry run cannot demonstrate non-zero extraction, document the limitation
and file a backlog item. Do not merge the manager. US4 is deliberately independent of US3 so that
this outcome cannot delay the dated remediation.

---

## R5 — Where the expiry logic is shared, and how the gates are tested

**Decision**: A new flat sibling module `scripts/allowlist-expiry.mjs`, imported by both gates.
Tests go in `scripts/__tests__/`, and each gate's existing `--selftest` gains cases.

**Rationale**: `scripts/` has **no `lib/` directory**; sharing is done with flat sibling imports
(`ci-digest-redact.mjs`, `openwiki-policy.mjs`, and `ci-status.mjs` are each imported by three or
more scripts). A new subdirectory would be the odd one out.

The two gates cannot share more than the expiry logic: their entries have different shapes —
`check-sast-findings.mjs` compiles `{scanner, id, locationPattern}` while
`check-infra-image-findings.mjs` compiles `{image, id}`. What they *do* share, verbatim, is the
expiry line (`check-sast-findings.mjs:80`, `check-infra-image-findings.mjs:89`). So the shared module
owns the window constant, the three-way classification, and the report formatting; each gate keeps
its own entry compilation and passes in a normalized view.

**Test wiring already exists**: `guardrails.yml:147` runs `node --test scripts/__tests__/*.test.mjs`,
and `check-sast-findings.test.mjs` / `check-toolchain-consistency.test.mjs` are already there. A new
`*.test.mjs` file is picked up by the glob with no workflow change. The `naming` job also runs each
gate's `--selftest` before its real scan (lines 133-134 show the convention), which is why the
constitution's Verify-RED requirement is satisfiable offline for every task in US5.

**Alternatives considered**:

- *Duplicate the change in both gates.* Rejected — directly violates FR-024 (window defined in
  exactly one place), and #154 itself offers it only as a lesser option.
- *Unify the two gates into one generic gate.* Rejected as YAGNI and a much larger blast radius on
  two merge-blocking scripts.

---

## R6 — Where `--check-expiring` runs, and how its failure is announced

**Decision**: A step in `infra-image-scan.yml`'s scan job, guarded by
`if: github.event_name == 'schedule'`, invoking the check over **both** allowlists.

**Rationale**: This is the only workflow with a real recurring trigger —
`infra-image-scan.yml:27` (`0 7 * * 5`). `wiki-maintain.yml` has **no cron at all** (push +
`workflow_dispatch` only), so the "weekly maintain job" named in item #154 does not exist in the form
the item implies.

The event guard is load-bearing: that job also runs on `pull_request` (path-gated, per lines 30-35).
Without the guard, a red expiry check would block pull requests — the precise outcome FR-021 and
SC-007 forbid.

**Announcement comes for free.** The job already invokes `scripts/ci-failure-digest.mjs` on failure
(lines 86-95 and 192-201, with `always()` + `continue-on-error`). A non-zero check mode in that job
is therefore published through the existing failure channel with **no new publish path** — which
retires the "route through the failure digest" option considered during brainstorming as a larger
change. It is not larger; it is already wired.

**Alternatives considered**:

- *Add a cron to `wiki-maintain.yml`.* Rejected — inventing a schedule where none exists, when a
  correctly-scheduled job with digest wiring is already available.
- *A new dedicated workflow.* Rejected — duplicates trigger and digest plumbing to run two script
  invocations, and adds another workflow that can silently stop.

---

## R7 — The remediation's real shape, and three corrected facts

**Decision**: Raise `fast-uri`'s existing floor, add a new `ip-address` floor, update
`minimumReleaseAgeExclude`, delete both allowlist entries.

**Rationale and corrections** (each changes what the tasks must do):

1. **`minimumReleaseAgeExclude` already exists** at `pnpm-workspace.yaml:28` and **already lists
   `fast-uri@3.1.4`**. FR-012 is therefore an edit to an existing line, not a new mechanism — and the
   stale `3.1.4` entry must be updated, not merely appended to.
2. **`fast-uri` already carries `fast-uri@<3.1.4: '>=3.1.4 <4'`.** The advisory bypasses the previous
   fix, so this is a floor *raise*, and by R3's invariant **both halves move**. `ip-address` has no
   override at all and is a clean addition.
3. **Eight allowlist entries carry expiries, not seven.** Item #154's prose says seven; its own table
   sums to eight and the files agree with the table — five in `security/sast/allowlist.yaml`
   (`fast-uri`, `ip-address`, `image-size` ×2, `click`), three in
   `security/infra-images/allowlist.yaml`. The two `expiry:` hits that are not entries are header
   comments.

**A trap the allowlist file itself documents**, and the reason FR-023 exists: the aiohttp/cryptography
entries re-blocked *before* their expiry because pip-audit began reporting the same advisories under
PYSEC aliases instead of CVE ids. *"An allowlist entry keyed on an exact advisory id silently stops
suppressing when the scanner switches identifier namespace — the entry does not expire, it just
quietly matches nothing."* Unmatched-entry reporting is what makes that legible.

**Verification standard (FR-013)**: these are JS-toolchain transitives, so a bad floor surfaces at
build time rather than in unit tests. The check is a build plus the web E2E baseline, not `nx test`.

---

## R8 — Predicted behaviour of the new signal

**Decision**: Record the first-red date as a falsifiable prediction rather than a vague expectation.

**Rationale**: With a 14-day window (clarification Q3) and Story 3 deleting the two entries dated
2026-08-31, the earliest remaining expiry is the `image-size` pair on **2026-09-07**. That enters the
window on 2026-08-24 (a Monday); the scan runs Fridays, so:

- **First run after merge: green.**
- **First red run: Friday 2026-08-28**, naming the `image-size` pair.

This matters because `image-size` has no published fix and its remediation is an Expo/metro upgrade
needing its own branch and a real build — the exact case #154 cited as "not something to discover on
the morning it starts blocking every PR". If the check goes red earlier or later than 08-28, either
the window constant or the scanner-guard logic is wrong, and the prediction says so.

---

## Unresolved

**None.** No `NEEDS CLARIFICATION` markers remain. The one genuine unknown — whether the custom
manager extracts (R4) — is not resolvable by research; it needs a dry run against the live bot. The
spec fixes the outcome in both directions (FR-014 proves it, FR-019 handles its absence), and US4 is
sequenced so that a negative result cannot delay the dated remediation in US3.
