---
type: Gotcha
title: Compound keyset pagination for movie lists
description: Why mc-service's movie list endpoint uses an opaque, base64-encoded compound keyset cursor instead of skip/offset pagination, and the traps in decoding, sort-field mapping, and count-vs-list filter parity.
resource: CLAUDE.md
tags: [mongodb, pagination, mc-service, rust]
timestamp: 2026-06-14T16:02:59-04:00
---

# Compound keyset pagination for movie lists

`GET /api/v1/collections/:id/movies` paginates with a keyset (a.k.a. seek) cursor, not
`skip()`/offset. The `cursor` query param is an opaque, base64-encoded JSON payload
(`PageCursor` in `backend/mc-service/src/adapters/mongodb/movie_repository.rs`) carrying the last
returned item's primary sort value, the `_id` tiebreaker, and — for title sort specifically — the
secondary `year` value. Each page's Mongo query becomes a `$gt`/`$lt` boundary on those fields
(`keyset_boundary()`) rather than "skip N documents," so query cost stays flat regardless of how
deep into the list the client has paged. Batch size is 50. A dedicated `sort_titlesort_year` index
(`collectionId, titleSort, year, _id`) backs the title-sort path; `_id` is always the final
ascending tiebreaker in every sort spec so repeated loads are stable even with duplicate sort keys.

## Gotchas

- **Never use `skip()` for this list — it degrades to O(N) at scale.** MongoDB has to walk and
  discard every skipped document; a keyset cursor is the reason this doesn't happen here. Adding a
  `skip`-based "jump to page N" feature would defeat the whole design.
- **The cursor is only valid for the `(sort_by, sort_dir)` it was minted under.** It's opaque to
  clients by design — don't try to hand-construct or mutate one, and don't assume a cursor from a
  title-sorted page works if the client then switches to year-sorted.
- **A malformed cursor must fail as a validation error, not a panic or a silent full-scan.**
  `decode_page_cursor()` returns `None` on bad base64/JSON, and the query layer turns that into
  `DomainError::ValidationError("Invalid pagination cursor")` — treat any change here as
  security-relevant since a badly-handled cursor is client-controlled input.
- **`count` intentionally ignores the `cursor` field but must share every other filter with
  `list`.** `build_movie_filter()` is the single shared filter-construction function specifically so
  the count and the paginated list can never disagree about how many results structurally match —
  don't duplicate the filter logic when adding a new query.
- **`titleSort` field remapping is a one-way trap:** `keyset_boundary()` reads the cursor's stored
  Mongo field name directly (`c.b`) rather than re-deriving it from `sort_by`, specifically because
  re-mapping through the general `sort_field()` helper would incorrectly fold `"titleSort"` back to
  the default field.

See [mc-service](/openwiki/projects/mc-service.md) for the CQRS query layer this pagination lives
in, and
[MongoDB indexes and uniqueness](/openwiki/gotchas/mongodb-indexes-and-uniqueness.md) for the
sibling indexing decisions in the same file.
