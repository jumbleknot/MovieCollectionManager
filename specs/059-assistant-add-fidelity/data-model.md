# Data model — 059 assistant add fidelity

**Date**: 2026-08-14 · **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

No stored field is added, removed, or migrated. Both target fields already exist on the movie
document. What changes is which in-memory structures carry a value between the lookup, the member's
answer, and the write.

## Existing stored fields (unchanged shape, changed values)

### `Movie.rated` — `Option<UsaRating>`

`backend/mc-service/src/domain/movie.rs:119`. The vocabulary is a closed set of seven values, and
the wire form is what matters (research R1):

| Wire / stored value | Internal Rust identifier | Meaning |
|---|---|---|
| `G` | `G` | rated G |
| `PG` | `PG` | rated PG |
| `PG-13` | `PG13` *(serde rename)* | rated PG-13 |
| `R` | `R` | rated R |
| `NC-17` | `NC17` *(serde rename)* | rated NC-17 |
| `NR` | `NR` | the film was **not rated** — a substantive claim |
| `Unrated` | `Unrated` | released in an unrated cut |
| `null` | `None` | **unknown** — no claim made |

The distinction the whole of US1 rests on is the last two rows: `null` is available and truthful,
`NR` is a statement about the film. Today the assistant writes `NR` unconditionally.

**Serialization constraint**: `CreateMovieDto` gives only `language` a serde default, so `rated`
must be **present** in the JSON — `"rated": null`, never an omitted key, or mc-service answers 422
(research R5).

### `Movie.childrens` — `bool`

`backend/mc-service/src/domain/movie.rs:111`. Required, not optional; `false` is a legitimate
default rather than a fabricated claim, which is why US2 ranks below US1. Already editable from the
movie edit screen and already settable by the assistant's conversational update path
(`compose_movie_payload`).

## In-memory structures

### `EnrichedMovieCandidate` (`agents/movie-assistant/src/proposals.py:55`)

What the assistant learned about a film from the external source, before any add.

| Field | Today | After |
|---|---|---|
| `source`, `source_id`, `title`, `year`, `overview`, `genres`, `poster_url`, `language`, `match_confidence` | present | unchanged |
| `rated` | **absent** | `str \| None = None` — the validated certification, or `None` when the source published none or published something outside the vocabulary |

Defaulting to `None` keeps every existing construction site valid, including the disambiguation path
that builds candidates from search results rather than a detail lookup.

### `ProposalItem` (`agents/movie-assistant/src/proposals.py:83`)

One reviewable change inside a HITL proposal. It already carries the 047 answers precisely so they
survive an approval that arrives turns later (research R9).

| Field | Today | After |
|---|---|---|
| `owned`, `owned_media`, `ripped`, `rip_quality` | the 047 answers | unchanged |
| `childrens` | **absent** | `bool \| None = None` — the member's answer, `None` for non-add items |
| `diff` | `{add_movie, to}` | **unchanged** — FR-018a keeps the approval surface as it is |

The rating deliberately does **not** get a field here: it is a property of the candidate, which the
item already carries, so duplicating it would create two sources of truth for one value.

## The add question chain (state)

Graph state keys, all already present except the stage value itself:

| Key | Values | Change |
|---|---|---|
| `add_stage` | `""`, `awaiting_collection`, `awaiting_pick`, `awaiting_ownership`, `awaiting_media`, `awaiting_ripped`, `awaiting_rip_quality` | **`awaiting_childrens` added** |
| `add_target` | the resolved collection | unchanged — resolved before the new question (FR-008a) |
| `add_owned_media`, `add_ripped`, `add_rip_quality`, `add_multi_pending` | in-flight 047 answers | unchanged |
| `add_childrens` | — | **new** — holds the answer between the question and the proposal |

### Transitions

```text
awaiting_childrens  --yes/no--> awaiting_ownership          (the answer is retained either way)
                    --unparseable--> awaiting_childrens     (re-ask; never guess — research R8)
                    --abandon--> nothing added               (FR-013)

awaiting_ownership  --no--> proposal   (childrens still applied — FR-009)
                    --yes--> awaiting_media
awaiting_media      --confirm--> awaiting_ripped
awaiting_ripped     --no--> proposal
                    --yes--> awaiting_rip_quality
awaiting_rip_quality --confirm--> proposal
```

Every transition from `awaiting_ownership` onward is 047's, unchanged (FR-017). The single structural
change is that `awaiting_childrens` is now the state the chain enters, and the state `awaiting_ownership`
is entered *from* rather than entered first.

## Validation rules

| Rule | Source | Where enforced |
|---|---|---|
| Certification must be one of the seven vocabulary values, else `None` | FR-003, FR-006 | web-api-mcp, at extraction |
| First non-empty US certification wins; no combining | FR-003a | web-api-mcp, at extraction |
| `NR` only when the source reports not-rated | FR-005 | falls out of pass-through validation — nothing writes `NR` on its own |
| `rated` key always present, possibly `null` | research R5 / mc-service DTO | `to_movie_payload` |
| Formats only when owned; qualities only when ripped | 047 FR-027 | mc-service (authority); `to_movie_payload` merely declines to send what was never asked |
| Rating and children's flag are independent — neither infers the other | spec Edge Cases | by construction: different sources, never read together |
