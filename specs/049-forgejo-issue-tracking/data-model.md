# Phase 1 — Data Model: Forgejo issue tracking

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Research**: [research.md](research.md)

The forge owns all persistence; this feature adds no store of its own. What follows is the shape the
tool reads and writes, the validation rules it enforces before touching the API, and the state
transitions it permits.

---

## Backlog item

The unit of tracked work. One forge issue.

| Field | Source | Notes |
| --- | --- | --- |
| `number` | forge-assigned | **Shared sequence with pull requests** (measured: PRs occupy #100–#143, the only issue is #29). Always written as `item #N` in prose to disambiguate. |
| `title` | required on create | Non-empty after trim; single line; control characters stripped. |
| `body` | file or stdin only | Never argv (FR-009). Shaped by the issue form's sections. Capped at 64 KB before send. |
| `state` | `open` \| `closed` | Changed by the update command, never by a merge (spec Assumptions). |
| `labels[]` | names, resolved before use | Every name must exist in the repo's label set or the command fails (see **Label**). |
| `milestone` | optional, name | Resolved against the repo's milestone list; unknown name fails. Absent = free backlog. |
| `blockedBy[]` | dependency graph | Authoritative source for readiness (not the `status/blocked` label). |
| `blocks[]` | dependency graph | The inverse edge. |
| `comments` | count + thread | Comment bodies are file/stdin only, same rule as `body`. |
| `author` | forge-assigned | Never used for filtering (measured: Renovate's dashboard is authored by the operator account — research D4). |

### Body sections (from the issue form)

`.forgejo/issue_template/backlog-item.yaml` fixes four sections so operator- and assistant-filed items
are structurally identical (FR-013, SC-011):

1. **Context** — what the work is and why it exists (free text, required).
2. **Acceptance criteria** — the checkable conditions whose verification is what licenses a close
   (FR-010, US3). Required.
3. **Affected components** — which deployable unit(s) or paths (free text, required).
4. **Discovered during** — the feature, session or incident that surfaced it (free text, optional).

The form additionally offers the type and priority labels as dropdowns so a web-UI filing lands with the
same taxonomy an assistant filing uses.

---

## Label

The machine-readable state of an item. **Zero labels exist in the repository today** (measured), so
setup creates the full set. Names are hierarchical strings; colours are cosmetic and set once.

| Family | Names | Meaning |
| --- | --- | --- |
| type | `type/bug`, `type/feature`, `type/tech-debt`, `type/chore` | What kind of work. Exactly one per item. |
| priority | `priority/p1`, `priority/p2`, `priority/p3` | Ordering key for the ready query. Exactly one per item. |
| status | `status/blocked` | Cheap pre-filter for readiness; the dependency graph remains the authority (research D7). |
| status | `status/needs-spec` | The explicit bridge marker: too large to implement without the spec → plan → tasks lifecycle first. |
| status | `status/bot-managed` | **Added by measurement, not by the PRD**: marks an item another automation owns (today: Renovate's Dependency Dashboard, item #29). Excluded from the ready query; never edited, closed or swept (research D4). |

### Validation rule that follows from a measurement

`labels=<unknown-name>` is **silently ignored by the API and returns the unfiltered set** (research D3).
Therefore every label name — on a filter, on a create, on an add/remove — is resolved against
`GET /labels` first, and an unknown name fails with the name quoted and the valid set listed. No label
name is ever passed through to the API unresolved.

---

## Milestone

A named grouping mapping items to a planned feature. Convention: the feature directory name
(`NNN-slug`, e.g. `049-forgejo-issue-tracking`). Optional — unmilestoned items are the free backlog
(FR-014). **Zero milestones exist today** (measured); they are created on demand, and an unknown
milestone name fails loudly rather than being dropped.

---

## Blocking relationship

A directed edge between two items in the same repository. Enabled on this repo (measured:
`internal_tracker.enable_issue_dependencies: true`).

- `A blockedBy B` — A cannot complete until B is resolved. A is excluded from the ready query and
  cannot be closed while B is open.
- `A blocks B` — the inverse edge, the same relationship read from the other end.

Both directions are readable per item and are the authority for readiness. Cycles are not created by the
tool: adding an edge that would close a cycle is refused before the call.

---

## Item state transitions

```text
                    ┌──────────────────────── reopen (update --state open) ────────────────┐
                    │                                                                      │
   (create) ──▶ OPEN ──── close (update --state closed), acceptance criteria verified ──▶ CLOSED
                 │
                 ├── add blockedBy edge ──▶ OPEN + blocked
                 │                            │
                 │                            ├── close attempt ──▶ REFUSED, item stays OPEN (FR-010)
                 │                            └── blocker closed / edge removed ──▶ OPEN (ready)
                 │
                 └── label status/bot-managed ──▶ OPEN, excluded from ready, never swept
```

Rules the tool enforces:

- **Close requires verification, not a merge.** Closure is an explicit act after the body's acceptance
  criteria are checked; no merge-time auto-closure (spec Assumptions, reinforced by the shared
  issue/PR number sequence — research D9/OQ-5).
- **A blocked item cannot be closed.** The refusal is classified and surfaced distinctly from any other
  failure, and the item is left open (FR-010). The exact response shape is captured during
  implementation and becomes the classifier's test fixture (research, open risk 2).
- **No bulk transitions without an explicit instruction** (spec Edge Cases): item history lives outside
  version control, so there is no `git revert` for a mass edit.

---

## Ready-work selection

The single query behind "what can I work on next" (FR-011, US2/US5):

1. List `state=open`, `type=issues`, paged with `page`+`limit` (cap 50, total from `x-total-count`).
2. Drop items labelled `status/bot-managed`.
3. Drop items labelled `status/blocked` (cheap pre-filter).
4. For each remaining candidate, read its blockers; drop any with an unresolved blocker. Concurrency
   capped at 4.
5. If step 3 and step 4 disagree — a `status/blocked` label with no blocking edge, or an unlabelled item
   with one — print a warning naming the item. The graph wins; the label is never silently corrected.
6. Order by priority label (`p1` → `p3`), then by item number ascending.

---

## Credentials (environment, not persisted)

| Name | Role | Required for | Measured today |
| --- | --- | --- | --- |
| `MCM_FORGE_ISSUE_TOKEN` | repository-read + item-write; reach across repositories deliberately unrestricted (operator decision, research D5) | every write; preferred for reads | present, reads fine; write path proven only by the step-5 sequence in [quickstart.md](quickstart.md) |
| `MCM_FORGE_TOKEN` | existing read-only diagnostics token | read fallback when the write token is absent | present, reads fine |

Neither value is ever logged, echoed, cached, or placed in argv. An absent write token degrades reads to
the fallback and refuses writes with the missing credential named (FR-005); it never blocks container
startup.
