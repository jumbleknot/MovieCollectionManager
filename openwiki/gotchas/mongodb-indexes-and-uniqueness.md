---
type: Gotcha
title: MongoDB collation uniqueness and the language_override trap
description: How mc-service enforces case-insensitive uniqueness for collection names and movie titles purely at the MongoDB index level, and why the (now-dropped) text-search index needed a fake language_override field to avoid write errors on non-Latin languages.
resource: CLAUDE.md
tags: [mongodb, indexes, rust, mc-service]
timestamp: 2026-07-28T02:22:54.286Z
---

# MongoDB collation uniqueness and the language_override trap

[mc-service](/openwiki/projects/mc-service.md) enforces two uniqueness rules purely with MongoDB
index options in `backend/mc-service/src/adapters/mongodb/indexes.rs` — there is no derived
lowercase field and no application-layer duplicate check:

- Collection name unique per owner (`unique_name_per_owner` index on `{ ownerId, name }`).
- Movie unique per collection (`unique_movie_per_collection` index on
  `{ collectionId, title, year, contentType }`).

Both indexes attach a `{ locale: "en", strength: 2 }` collation, which makes the uniqueness
comparison case-insensitive without normalizing the stored value. When an insert/update violates
either index, MongoDB returns error code `11000` (`E11000 duplicate key`), which the adapter layer
(`is_duplicate_key()` in `collection_repository.rs` / the movie repository) translates into the
domain errors `DuplicateCollectionName` / `DuplicateMovie` — callers never see a raw Mongo error.

## Gotchas

- **Collation is the whole mechanism — don't "helpfully" add a lowercase mirror field.** The
  uniqueness and case-insensitivity are both delegated to the index; adding a derived field would
  be redundant and could drift out of sync with the collation-enforced truth.
- **The now-removed `movie_text_search` `$text` index needed a language lie.** While it existed, it
  set `language_override: "textSearchLang"` (a field that is never populated) together with
  `default_language: "none"`. Without that, MongoDB would try to interpret the movie document's
  real `language` field (e.g. `"Japanese"`, `"Korean"`) as a `$text` index language override.
  MongoDB only recognizes a small fixed set of stemmer languages — no CJK — and would reject
  inserts with an unsupported value (`WriteError` code 17262). The app has since switched from
  `$text` to `$regex` search (`indexes.rs` drops `movie_text_search` on startup, ignoring errors if
  it's already gone), but the reasoning is worth knowing if text search is ever reconsidered.
- **Index creation on startup is idempotent by design** (`create_indexes()` runs
  `createIndexes` with explicit names every boot) — don't assume a schema migration step is needed
  when adding a new index; add it here and it self-heals on the next deploy.

See [mc-service](/openwiki/projects/mc-service.md) for the service's layer architecture and
[Keyset pagination](/openwiki/gotchas/keyset-pagination.md) for how the sibling cursor/sort indexes
in the same file are used.
