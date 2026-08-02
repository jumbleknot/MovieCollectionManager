# Contract: import progress and interrupted-import reporting

**Feature**: [047](../spec.md) · **Story**: US3 · **Satisfies**: FR-014, FR-014a, FR-014b, FR-015,
FR-016, FR-016a, FR-016b, FR-019b

> **Provisional on [RQ-2](../research.md#rq-2).** The *shape* below is settled; the *transport* is
> not. RQ-2 chooses between an AG-UI state channel (leaning) and streamed message deltas. If the
> fallback is taken, FR-014a's "updates in place" cannot hold as written and goes back to the
> product owner — it is not something implementation may quietly redefine.

## Progress payload

```jsonc
{
  "runId": "import:thread-abc123",
  "processed": 1200,
  "total": 2300,
  "state": "running",
  "note": null
}
```

| Field | Type | Notes |
|---|---|---|
| `runId` | string | The proposal id of the run in flight. Correlates progress with its report. |
| `processed` | integer | Rows attempted so far (applied + skipped + failed). |
| `total` | integer | Rows the approved proposal will attempt, after tab exclusions. |
| `state` | enum | `running` \| `waiting` \| `done` \| `interrupted`. |
| `note` | string \| null | Set when `state` is `waiting` — the member must be told it is waiting rather than watching a stalled number (FR-019b). |

Carries counts only. No titles, no payloads, no token — it is emitted from checkpointed counters
(see [data-model.md §1.3](../data-model.md)).

## Emission rules

- Emitted only when an import would not otherwise complete promptly; a small import shows no
  progress surface at all.
- Advances at least every 10 seconds while running (SC-008).
- **At most one progress surface per import run** (SC-008, FR-014a) — a new update replaces the
  previous one; it never appends a second.
- On completion the progress surface is replaced by the existing `render_import_report` card
  (FR-014b). The member is never left with a stale count as the last thing they see.

## Terminal states

| State | What the member sees |
|---|---|
| `done` | The existing `render_import_report` — imported / skipped / failed with per-row reasons. |
| `interrupted` | On the **next** turn: how many rows were applied out of the total, and that re-uploading the same file will finish it (FR-016b). |

Rows already applied are never rolled back (FR-016a). Re-running is safe because every item carries
a deterministic idempotency key and mc-service returns `409` for a movie that already exists, which
the gate already classifies as `skipped_duplicate` rather than a failure (FR-018).

## Up-front size ceiling (FR-015)

A file whose eligible rows exceed **5,000** is refused at parse time, before any preview work:

> That file has 6,240 rows, which is more than I can import in one go (the limit is 5,000). Please
> split it into smaller files and import them one at a time.

The check runs before planning, so an oversized file never pays the cost of an import it cannot
finish. The limit is a named constant, not a literal scattered through the node.

## What must be tested

- A 2,000-row import emits advancing progress and exactly one progress surface.
- The progress surface is replaced by the report, not left beside it.
- An import interrupted mid-apply leaves applied rows in place and reports correctly on the next
  turn.
- Re-running an interrupted import creates no duplicates.
- A 5,001-row file is refused with the message above and produces no preview and no writes.
