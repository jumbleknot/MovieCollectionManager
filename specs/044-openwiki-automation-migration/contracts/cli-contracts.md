# Contracts — Feature 044

**Date**: 2026-07-30 · **Plan**: [../plan.md](../plan.md) · **Data model**: [../data-model.md](../data-model.md)

The interfaces this feature exposes are **command-line surfaces** and **file schemas**. There is no HTTP
API, no library export. Contracts below are what `tasks.md` writes tests against.

---

## C1 — `scripts/wiki-maintain.mjs`

The orchestrator. Same code path locally and in CI (FR-020).

```text
node scripts/wiki-maintain.mjs --plan   [--since <ref>] [--json]
node scripts/wiki-maintain.mjs --execute [--plan-file <path>] [--max-slices <n>] [--dry-run]
node scripts/wiki-maintain.mjs --selftest
```

| Flag | Behaviour |
|---|---|
| `--plan` | Offline. Computes the plan and prints it. **No model call, no network** (FR-003). Always safe to run |
| `--execute` | Runs slices through the Nx target, verifying each. Requires `ANTHROPIC_API_KEY` |
| `--since <ref>` | Override the run-record marker. Diagnostics and the one-time trim |
| `--max-slices <n>` | Cap slices this invocation; the budget guard may stop earlier |
| `--dry-run` | Renders run messages and prints what would be invoked, without invoking |
| `--json` | Machine-readable output for CI and the failure digest |
| `--selftest` | Exercises planner and verifier against fixtures. Offline, keyless |

**Exit codes** — deliberately mirroring the existing gate family:

| Code | Meaning |
|---|---|
| `0` | Plan produced, or all attempted slices verified, or nothing to do |
| `1` | A slice failed verification — zero pages written, or the bundle became non-conformant |
| `2` | Bad usage, unreadable state, or missing credential on `--execute` |
| `3` | Stopped at the budget ceiling with work outstanding. **Not a failure** — the remainder is in the backlog |

Exit `3` exists for the same reason `ci-status.mjs` distinguishes starvation from failure: a run that
correctly stops at its budget must not be reported as broken.

**Hard contract — the generator's exit status is never trusted.** Success is: *pages appeared* AND *the
conformance gate passes* AND *every written path was permitted by `policy.yaml`*. Research R2 established
the tool has no programmatic scoping surface, so the slice bound is advisory text; verification is the only
enforcement that exists (FR-005, FR-006, FR-026e).

**Invocation of the generator** is always `pnpm nx wiki-update infrastructure-as-code`, never the bare CLI
— the target carries the pinned model, the raised heap, and the telemetry opt-out (FR-021/FR-022).

### Plan output (`--plan --json`)

```json
{
  "generatedAt": "2026-07-30T12:00:00Z",
  "baseCommit": "abc1234", "sinceCommit": "def5678",
  "changedPaths": ["docs/runbooks/local-dev.md"],
  "slices": [{ "area": "runbooks", "pages": ["local-dev.md"], "areaExists": true,
               "reason": "source changed", "runMessage": "Update only …" }],
  "deferred": [], "plannedPages": 1
}
```

---

## C1a — amendments made during implementation, and why

Each was forced by a measurement, not by preference. Recorded here so the contract matches the code.

| Change | Measured reason |
|---|---|
| Two extra CLI modes: `--should-wait [--dispatched]` (the debounce decision, offline) and `--propose` (reconcile + publish, on `--execute`) | The workflow needs both, and putting the logic in YAML would have made the CI path diverge from the local one — the thing FR-020 exists to prevent |
| The run message travels in **`WIKI_RUN_MESSAGE`**, not on the command line, and the existing `wiki-update` target consumes it (C5 said "unchanged") | `nx --args` **strips the quoting from its value** before splicing it into the shell, so the message reached the generator as bare words and it ran UNSCOPED. The quoting has to live in the target's own command string, which nx leaves alone. With the variable unset the target behaves exactly as before |
| `--output-style=stream` on the generator invocation | Nx discards a successful task's output, so a 393-second paid run that wrote nothing left no diagnosable trace |
| The run message carries a **subject** per page, not just a filename | The generator spends its budget deducing what each page should say; three runs died mid-research having written nothing. 0 pages in 643s versus 3 pages in 367s |
| `MAX_NEW_PAGES_PER_SLICE = 3` alongside FR-002's cap of 8 | 043's "8 pages, reliably, twice" was measured on *refreshes*. Creation is dearer. FR-002 sets a ceiling, not a target, so this needs no spec change |
| Success is "every **requested** page exists", not "at least one page was written"; a refresh needing no change reports `noChange` | The old test was both too weak (a run writing unrelated pages passed) and too strong (an already-accurate page was called broken, which also halted the run) |

---

## C2 — `scripts/check-openwiki-governance.mjs`

Keyless, offline, fail-closed. Runs on **every** change as steps in the existing `okf` job (research R5 —
reusing that job avoids a new CI failure-digest obligation).

```text
node scripts/check-openwiki-governance.mjs [--selftest] [--json]
```

**Exit codes**: `0` clean / selftest passed · `1` violation / selftest broken · `2` bad usage. Identical to
the nine sibling gates.

**Rules** — continuing the existing `V` series (`check-openwiki-okf.mjs` owns V1–V13):

| Rule | Check | Requirement |
|---|---|---|
| **G1** | Every documentation path matches a `policy.yaml` entry — nothing unclassified | FR-026a |
| **G2** | `policy` value is one of the five declared states | FR-026b |
| **G3** | `actor: generator` appears only for paths inside `openwiki/` | FR-026c |
| **G4** | `event-driven` entries declare their `events`, including creation events | FR-026b |
| **G5** | Every protected passage's text still matches its fingerprint | FR-029 |
| **G6** | A listed passage absent from its concept fails as a **removal** | FR-029c |
| **G7** | No protected passage sits in a concept carrying a `resource` link | FR-041a |
| **G8** | `CLAUDE.md` contains only index entries and the three managed regions | FR-040 |
| **G9** | Every index entry resolves to an existing concept | FR-039, FR-031 |
| **G10** | Assistant-facing configuration surfaces point at no moved content | FR-033 |
| **G11** | Every concept is **exactly one** of derived (resolving `resource`) or authoritative (listed in `protected.yaml`) — never both, never neither | FR-030, FR-037, FR-038 |
| **G12** | An authoritative concept's effective policy is not `regenerate` | data-model E4 |

**Failure output** must name the concept, the anchor, and what changed — a reader may not know the passage
was protected, since the concept does not say so (FR-029e).

**Fail-closed**: a missing or unparseable `policy.yaml` or `protected.yaml` is a violation, never a skip.
There is no opt-out flag, matching the OKF gate's V10 posture.

---

## C3 — `openwiki/policy.yaml` and `openwiki/protected.yaml`

Schemas, validation rules and the actor constraint are specified in
[../data-model.md](../data-model.md) E4 and E5. Both files are hand-authored, `never-written` in their own
policy, and invisible to the generator (which writes markdown only).

---

## C4 — `.forgejo/workflows/wiki-maintain.yml`

| Property | Contract |
|---|---|
| Triggers | `push` to `main`; `workflow_dispatch` (bypasses debounce, FR-009c) |
| Debounce | `concurrency: { group: wiki-maintain-main, cancel-in-progress: true }` + an initial wait. A new push cancels the waiter and restarts it, so the run proceeds only after ~15 quiet minutes (research R3) |
| Maximum deferral | Before waiting, compare the age of the oldest commit not covered by the run record against the threshold; skip the wait when exceeded. **Git-derived, so it survives cancellation** (FR-009b) |
| Self-trigger guard | Bundle-only changes and `[skip ci]` marker commits do not trigger (FR-009a) |
| Secrets | `ANTHROPIC_API_KEY` + the existing write-scoped token. **No new store entry** (FR-023, research R9) |
| Required context | **Never.** Not added to branch protection (FR-019) |
| Failure evidence | Publishes a feature-042 digest via `ci-failure-digest.mjs` (FR-018) |
| Outcome reporting | `nothing-to-do` / `completed` / `failed` are distinct; a credential or capacity failure is never reported as nothing-to-do (FR-017) |
| Proposal | Single branch, single PR, rebased and appended. **Never auto-merged** (FR-013) |

---

## C5 — Nx targets (`infrastructure-as-code/project.json`)

| Target | Command | Notes |
|---|---|---|
| `wiki-plan` | `node scripts/wiki-maintain.mjs --plan` | Offline, free, always safe |
| `wiki-maintain` | `node scripts/wiki-maintain.mjs --execute` | Paid; needs `ANTHROPIC_API_KEY` |
| `okf-governance` | `node scripts/check-openwiki-governance.mjs` | Keyless gate |
| `wiki-update` | *(existing, unchanged)* | The pinned-model generator invocation |
| `okf-lint` | *(existing, unchanged)* | V1–V13 bundle conformance |

Each new target carries a `metadata.description` explaining why it must be used instead of a bare call —
matching the existing `wiki-update` and `okf-lint` entries, whose descriptions are load-bearing.

---

## C6 — Run budget (page + wall-clock)

Research **R1** established that OpenWiki 0.2.3 emits no token or cost data, and FR-011 was amended
accordingly. The budget guard consumes two **directly observed** quantities — no estimate, no proxy, and
no monetary claim (FR-011d).

| Property | Contract |
|---|---|
| Page budget | Default **16 pages** per run (two full slices). Counted from **files actually written in the working tree**, never from the generator's self-report (FR-011b) |
| Wall-clock budget | Default **20 minutes** per run. Measured by the run itself |
| Enforcement point | Between slices — if either budget is reached, the next slice is not started and carries forward (FR-011) |
| Overshoot | Bounded at **one slice**: ≤8 pages and ≤~17 min (043's measured worst case). **Declared effective ceiling: ≤24 pages / ~37 minutes** (FR-011a) |
| Workflow timeout | `timeout-minutes: 45` — above the effective ceiling plus checkout and install overhead |
| Budget stop | Exit `3`, distinct from failure (FR-017, SC-006a) |
| Tunability | Both values are configuration, changeable without touching the planner or verifier |

**Why the page count must come from the tree**: research R2 established there is no programmatic scoping
surface — the page list is free text in a run message, so nothing prevents the generator producing more
than it was asked for. A budget that trusted the tool's account of its own output would inherit exactly the
false-green failure this feature exists to eliminate.

**Deliberately not claimed**: neither budget bounds monetary cost. The repository has no cost measurements,
and the generator supplies none.
