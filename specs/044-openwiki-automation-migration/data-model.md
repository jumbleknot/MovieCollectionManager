# Data Model — Feature 044

**Date**: 2026-07-30 · **Plan**: [plan.md](plan.md) · **Spec**: [spec.md](spec.md)

Every entity here is a plain file in git. There is no database, no cache, and no runtime store — the
model is the file set, and the gate is what enforces it.

---

## E1 — Slice

The bounded unit of generation. Produced by the planner, consumed by the executor, judged by the verifier.
Exists only in memory and inside the plan; never persisted alone.

| Field | Type | Rules |
|---|---|---|
| `area` | string | Exactly one bundle directory (e.g. `gotchas`). A slice never spans two |
| `pages` | string[] | 1–8 entries, concept filenames. **Max 8** — the largest size 043 delivered reliably, twice (FR-002) |
| `areaExists` | boolean | Whether `area` already exists in the bundle |
| `reason` | string | Why the planner included it — a changed source path, or carried-forward backlog |
| `runMessage` | string | Rendered free-text instruction naming `pages` explicitly. **The only scoping surface** (research R2) |

**Invariant (the one that mattered)**: a slice MUST NOT both add pages to an existing area and create a
new one. Of 043's eight measured runs, the single slice that produced *nothing* was the only one shaped
that way; splitting along that seam fixed it immediately. The planner cannot emit such a slice.

**Validation**: `pages.length` between 1 and 8; `area` is a single path segment; `areaExists` is derived
from the working tree, never supplied.

---

## E2 — Maintenance plan

The ordered slice list plus the context that produced it. Written to disk so it is inspectable **before**
any spend (FR-004), and reused by the executor so plan and execution cannot disagree.

| Field | Type | Rules |
|---|---|---|
| `generatedAt` | ISO 8601 | |
| `baseCommit` | string | `HEAD` the plan was computed against |
| `sinceCommit` | string | Run-record marker the change set was derived from |
| `changedPaths` | string[] | Documentation paths changed in the range, after policy filtering |
| `slices` | Slice[] | Ordered; empty means nothing to do |
| `deferred` | Slice[] | Beyond the budget for this run; carried forward |
| `plannedPages` | number | Total pages across `slices`, checked against the page budget |

**State**: ephemeral per invocation. Not committed; regenerating it is free because the planner makes no
model call (FR-003).

---

## E3 — Run record and backlog — `openwiki/.maintenance-state.json`

Committed, because runners are ephemeral and FR-012 requires the marker to advance even on a run that
creates no proposal (research R4). Advanced by a `[skip ci]` commit so it cannot re-trigger maintenance
(FR-009a).

| Field | Type | Rules |
|---|---|---|
| `coveredCommit` | string | Newest commit whose documentation impact has been examined. Advances even when nothing was documented — this is what makes the no-cost path reachable |
| `coveredAt` | ISO 8601 | |
| `lastOutcome` | enum | `nothing-to-do` \| `completed` \| `failed`. Exactly the three FR-017 requires distinguishing |
| `backlog` | Slice[] | Planned but not completed — deferred by budget, or failed |
| `proposal` | object \| null | `{ branch, number, headCommit }` for the single open proposal, or `null` |
| `lastRunBudget` | object | `{ pagesWritten, elapsedSeconds, stoppedAtBudget }` — observed, not reported by the generator (FR-011b) |

**Distinct from `openwiki/.last-update.json`**, which the **tool** owns (`updatedAt`, `command`,
`gitHead`, `model`). That file is not repurposed: a tool-owned file cannot safely carry our semantics
across an upgrade, and 043 measured it advancing only when wiki content changed — the exact behaviour that
made the free path unreachable.

**State transitions**:

```text
                 ┌─────────────────────────────────────────┐
                 │                                         │
  covered=X ──plan──> nothing-to-do ──advance marker──> covered=Y
      │                                                    ▲
      ├──plan──> slices ──execute──> verify ──ok──> propose ┤
      │                                 │
      │                                 └──zero pages/nonconformant──> failed
      │                                        (slice returns to backlog, marker does NOT advance)
      │
      └──proposal closed unmerged──> its work returns to backlog, marker rolls back (FR-016b)
```

The rollback edge is the one that prevents a permanent invisible gap: without it, abandoning a proposal
leaves the marker certifying work that never landed.

---

## E4 — Regeneration policy — `openwiki/policy.yaml`

Hand-authored. Declares, per path, **when** it may be written and **which actor** the assignment governs.
Replaces 043's location-based ownership rule, which stopped holding once instruction content moved into
the bundle.

```yaml
version: 1
paths:
  - glob: "docs/runbooks/**"
    policy: regenerate
    actor: agent            # NOT the generator — its write scope is the bundle only
    rationale: "Operational truth tracks the repository and goes wrong as it changes"
  - glob: "docs/decisions/**"
    policy: event-driven
    actor: agent
    events: [decision-reached, decision-superseded]
  - glob: "docs/test-data/**"
    policy: excluded
  - glob: "specs/**"
    policy: analyzable-not-covered
    exceptions: ["specs/*/HANDOFF.md"]
```

| Field | Type | Rules |
|---|---|---|
| `glob` | string | Repository-relative |
| `policy` | enum | `regenerate` \| `event-driven` \| `excluded` \| `never-written` \| `analyzable-not-covered` |
| `actor` | enum | `agent` \| `generator`. **`generator` is valid only for paths inside `openwiki/`** |
| `events` | string[] | Required when `policy: event-driven`. Includes creation events, not only correction ones |
| `exceptions` | string[] | Globs escaping the parent assignment |

**Validation** (enforced by the gate):

- Every documentation path in the tree matches at least one entry — no path is unclassified.
- `actor: generator` outside `openwiki/` is a violation. This is the mechanical expression of FR-026c.
- `event-driven` without `events` is a violation — the state is meaningless without its trigger.
- The authoritative-concept assignment must not be `regenerate` (see E5's protection rule).

---

## E5 — Protection manifest — `openwiki/protected.yaml`

Hand-authored, and deliberately **outside the generator's write scope**: the generator writes `*.md`,
`index.md`, `log.md` and `.last-update.json`, and the existing gate reads markdown only, so a `.yaml`
sibling is invisible to both. Putting the guard inside the concept it guards would let a refresh strip it,
and a stripped marker reads as "not protected" rather than as a failure.

```yaml
version: 1
authoritative:            # concepts that ARE canonical — no upstream source exists
  - "gotchas/musl-vendored-openssl.md"
passages:                 # load-bearing text within them, fingerprinted
  - concept: "gotchas/musl-vendored-openssl.md"
    anchor: "mc-service Docker build requires vendored OpenSSL"
    fingerprint: "sha256:…"
    origin: "CLAUDE.md#non-obvious-design-decisions"
    relocatedAt: "2026-07-30"
```

**The `authoritative:` list is what makes the routing rule decidable.** Without it, "does a learning about
this subject go upstream or into the concept?" is answerable only by noticing whether a `resource` field
happens to be present, and an authoritative concept is indistinguishable from a derived one whose citation
was forgotten. With it, every concept is provably one class or the other (rule G11), which is also what
lets a reader see that a concept is protected — the concept body itself never says so.

A concept may be authoritative without holding any fingerprinted passage; the two lists are related but
not coextensive.

| Field | Type | Rules |
|---|---|---|
| `authoritative` | string[] | Concepts declared canonical. Every concept MUST be **exactly one** of listed here or carrying a resolving `resource` — never both, never neither (G11) |
| `concept` | string | Bundle-relative path. MUST appear in `authoritative` |
| `anchor` | string | Stable locator (heading text) for the human-readable failure message |
| `fingerprint` | string | `sha256:` of the normalized passage text |
| `origin` | string | Where it came from, for auditability of the trim |
| `relocatedAt` | date | |

**Validation**:

- The manifest is **authoritative**: a listed passage whose text no longer appears in `concept` fails as a
  removal, not silently (FR-029c). A fingerprint comparison against absent text must not pass for lack of
  anything to compare.
- Protection MUST NOT attach to a concept carrying a `resource` link. Freezing a derived summary against
  the document it summarizes would fail every legitimate refresh, turning protection into a permanent
  blocker (FR-041a).
- Changing a protected passage legitimately means updating its fingerprint **in the same change** — the
  reviewable escape hatch (FR-029d).
- Failures name concept, anchor and what changed, because the concept itself does not disclose that a
  passage is protected (FR-029e).

**Normalization before hashing** must be defined once and tested: collapse trailing whitespace, normalize
line endings, and preserve everything else. Over-normalizing would let a meaning-changing edit pass.

---

## E6 — Maintenance proposal

Not a file — forge state, mirrored in `E3.proposal`.

| Field | Rules |
|---|---|
| `branch` | One long-lived branch. Rebased onto `main` and appended to, never wholesale force-replaced, so a human's remediation commit survives (FR-016a) |
| `number` | Forge pull-request number |
| `state` | `open` → merged (work lands, marker holds) or closed-unmerged (work returns to backlog, marker rolls back) |

**Invariant**: at most one open proposal at any time (FR-016). A run finding one open extends it.

---

## E7 — Instruction index — `CLAUDE.md` after the trim

| Region | Rule |
|---|---|
| Index entries | Subject → concept link. Derivable from the bundle, so it cannot drift (FR-039) |
| `<!-- nx configuration -->` | Untouched (Nx-owned) |
| `<!-- SPECKIT -->` | Untouched (Spec Kit-owned) |
| `<!-- OPENWIKI -->` | Untouched (generator-owned, rewritten every run) |
| Anything else | **Violation** — prose beyond the index fails the gate (FR-040), which is what stops the file silently re-growing |

The correction note below the OpenWiki block loses its "there is no scheduled workflow" clause, because
this feature makes that block's claim true.
