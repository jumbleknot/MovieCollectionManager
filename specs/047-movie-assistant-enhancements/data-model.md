# Phase 1 Data Model: Movie Assistant Enhancements & Fixes

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Date**: 2026-08-02

No persistent schema changes. mc-service's collections and movies are untouched, and `agent-db`
holds the same LangGraph checkpoint structure it does today — only the *fields inside* the graph
state change. This document describes those state fields, the in-memory shapes the pure resolvers
pass around, which movie payload fields stop being hardcoded, and the one new read-only DTO added to
mc-service by [RQ-4](./research.md#rq-4)'s resolution.

---

## 1. Graph state — new and changed fields

All fields live in `GraphState` ([graph.py](../../agents/movie-assistant/src/graph.py)) and are
checkpointed. **No field here may carry a token, a file byte, or PII** — the existing checkpoint
rules apply unchanged.

### 1.1 Add lifecycle (Story 4)

`add_stage` is an existing string field. Today it takes `""`, `awaiting_pick`,
`awaiting_collection`, `awaiting_ownership`. Three values are added:

| Value | Meaning | Next |
|---|---|---|
| `awaiting_media` | "Which formats do you own it on?" is pending | `awaiting_ripped` on confirm |
| `awaiting_ripped` | "Is it ripped?" is pending | `awaiting_rip_quality` on yes, build proposal on no |
| `awaiting_rip_quality` | "Which rip qualities?" is pending | build proposal on confirm |

Transitions (FR-020 → FR-027):

```text
awaiting_ownership --no--> build proposal (owned=false, media=[], ripped=false, quality=[])
awaiting_ownership --yes--> awaiting_media
awaiting_media --confirm--> awaiting_ripped          # confirming zero selections is legal (FR-028)
awaiting_ripped --no--> build proposal               # quality stays empty (FR-026)
awaiting_ripped --yes--> awaiting_rip_quality
awaiting_rip_quality --confirm--> build proposal
any of the above --abandon/new command--> discard pending add (FR-029)
```

| New field | Type | Notes |
|---|---|---|
| `add_owned_media` | `list[str]` | Confirmed media formats. Empty until `awaiting_media` is confirmed. Cleared by `_ADD_STATE_RESET`. |
| `add_ripped` | `bool \| None` | `None` until answered. |
| `add_rip_quality` | `list[str]` | Confirmed rip qualities. Empty unless `add_ripped` is `True`. |
| `add_multi_pending` | `list[str]` | The options offered by the current multi-select, so a typed-list reply (FR-036) resolves against the same set the buttons showed. |

All four join the existing `_ADD_STATE_RESET` so a concluded or abandoned add cannot leak into a
later turn — the same discipline the existing add fields follow.

### 1.2 Import questioning (Story 2)

| New field | Type | Notes |
|---|---|---|
| `import_unresolved_replies` | `int` | Consecutive replies that resolved nothing for the *current* prompt. Reset to 0 whenever a pick resolves or the prompt changes. Drives FR-010's escape at 2. |
| `import_decisions_remaining` | `int` | How many distinct decisions are still outstanding, rendered in the question text (FR-008). Derived, but checkpointed so a resumed turn does not recount. |

### 1.3 Import run progress (Story 3)

Counters only — never payloads, so the checkpoint stays small (see [RQ-3](./research.md#rq-3)).

| New field | Type | Notes |
|---|---|---|
| `import_total` | `int` | Rows the approved proposal will attempt. |
| `import_applied` | `int` | Rows applied so far. Advances during the apply loop. |
| `import_run_id` | `str` | The proposal id of the run in flight; empty when none. |

An unfinished run is detectable on a later turn as `import_run_id != "" and import_applied <
import_total` — that is what FR-016b reports on, and it is cleared once reported.

---

## 2. In-memory shapes (not persisted as-is)

### 2.1 `ImportPrompt` — key and label normalisation (Story 2)

`ImportPrompt` ([import_disambiguation.py](../../agents/movie-assistant/src/nodes/import_disambiguation.py))
keeps its fields (`kind`, `key`, `question`, `options`). What changes is a rule, not a shape:

> **Rule N1.** For an `article` prompt, `key` and every option `title` are the **trimmed** title.
> The raw cell value is never used as a key or a label.

This is the loop fix. The resolution accumulator `resolutions["article"]` is therefore keyed by
trimmed title, and the row-scan that decides whether to re-ask compares trimmed titles on both
sides — so an answered title is provably never re-asked (FR-007, SC-004).

### 2.2 Existing-movie index (Story 3)

`_plan_writes` currently scans a list per row. It gains a prepared index built once per tab:

| Key | Value |
|---|---|
| `(normalised_title, year)` | the existing movie dict |

`normalised_title` reuses the existing article-insensitive comparison key from
[text_match.py](../../agents/movie-assistant/src/text_match.py) — the same normalisation
`match_existing_movie` applies today, so **matching behaviour is unchanged**; only its cost is. Any
change in which rows match would be a regression, and must be covered by a test that runs the old
and new matcher over the same fixture.

### 2.3 Multi-select option (Story 4)

The `render_multi_select` tool's option shape, mirroring `render_selection`'s conventions:

| Field | Type | Notes |
|---|---|---|
| `label` | `str` | Button text shown to the member. |
| `value` | `str` | Canonical value recorded when selected. |
| `selected` | `bool` | Initial toggle state; `false` for a fresh question. |

Full contract: [contracts/render-multi-select.md](./contracts/render-multi-select.md).

---

## 3. Movie payload fields that stop being hardcoded (Story 4)

`to_movie_payload` ([proposals.py:187-191](../../agents/movie-assistant/src/proposals.py#L187-L191))
currently writes `"ownedMedia": []` and `"ripQuality": []` unconditionally and takes `owned` as its
only ownership input. It gains `owned_media`, `ripped` and `rip_quality` parameters.

| Payload field | Today | After |
|---|---|---|
| `owned` | member's yes/no | unchanged |
| `ownedMedia` | always `[]` | member's confirmed formats; `[]` when `owned` is false |
| `ripped` | always `false` | member's yes/no |
| `ripQuality` | always `[]` | member's confirmed qualities; `[]` when `ripped` is false |

**Validation stays in mc-service.** `OwnedMediaWhenOwnedSpec` and `RipQualityWhenRippedSpec` already
reject formats on an unowned movie and qualities on an unripped one. The agent's job is to send what
the member chose and surface the rejection if one comes back — it must not re-implement the rule
(FR-027, and the constitution's *No Domain Logic in Agents*).

The allowed values for `ownedMedia` and `ripQuality` are the same `MediaFormat` set. Per
[RQ-4](./research.md#rq-4) (resolved) they are **fetched from the domain at question time**, not
held in the agent: mc-service publishes them at `GET /api/v1/movie-metadata` and movie-mcp exposes
them as the `get_movie_metadata` read tool. See
[contracts/movie-metadata.md](./contracts/movie-metadata.md).

New DTO in mc-service (`MovieMetadataDto`), returned by that endpoint:

| Field | Type | Source |
|---|---|---|
| `mediaFormats` | `Vec<String>` | Every `MediaFormat` variant's serde wire value, produced by an exhaustive match so a new variant fails to compile until it is published |

The strings are the wire values (`"Blu-Ray"`, not `BluRay`) — the same representation `add_movie`
accepts, so a value the member picks is a value mc-service takes.

---

## 4. Imported-value normalisation (Story 2)

> **Rule N2.** Every imported text value is trimmed of leading and trailing whitespace before it is
> used for matching and before it is stored (FR-011).

Applied at row-transform time in
[import_resolvers.py](../../agents/movie-assistant/src/nodes/import_resolvers.py) so that a single
place governs it. `split_multi_value` already trims its parts; this extends the same treatment to
single-valued cells.

Note the interaction with an existing rule: `_is_blank` treats a whitespace-only string as blank so
it cannot overwrite an existing attribute on update. Trimming earlier does not change that outcome —
a whitespace-only cell trims to `""`, which `_is_blank` still rejects. A test should pin this,
because it is the kind of interaction a normalisation change quietly breaks.

---

## 5. Entity mapping back to the spec

| Spec entity | Where it lives |
|---|---|
| Movie ownership details | §1.1 state fields → §3 payload fields → mc-service `Movie` |
| Import decision | `resolutions` accumulator, keyed per §2.1 Rule N1 |
| Import run | §1.3 counters + the existing `ApplyResult` aggregate |
| Search session | Existing `search_stage` / `search_results`; unchanged by this feature (Story 5 adds no state) |
