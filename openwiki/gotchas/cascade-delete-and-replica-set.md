---
type: Gotcha
title: Cascade delete is a MongoDB transaction — replica set required
description: Why deleting a collection in mc-service requires a replica-set-enabled MongoDB — the collection and its movies are removed inside one multi-document transaction so a mid-delete crash can't orphan movie records.
resource: CLAUDE.md
tags: [mongodb, transactions, mc-service, rust]
timestamp: 2026-06-04T18:19:55-04:00
---

# Cascade delete is a MongoDB transaction — replica set required

Deleting a collection must also delete every movie inside it. `MongoCollectionRepository::delete()`
(`backend/mc-service/src/adapters/mongodb/collection_repository.rs`) does this inside a single
MongoDB session/transaction: it opens a `ClientSession`, deletes the collection document
(`delete_one` filtered by both `_id` and `ownerId`), and only if that succeeds cascades to
`delete_many` on the movies with the matching `collectionId`, then commits. If the collection
delete matches zero documents — meaning the caller doesn't own it — the transaction is aborted
before any movie is touched, so ownership is always verified *first*, inside the same atomic
unit as the cascade.

## Gotchas

- **MongoDB transactions require a replica set — a bare `docker run mongo` will not work.** A
  single standalone `mongod` process cannot start a session-backed transaction at all; the writes
  will fail immediately. Local/dev/CI MongoDB must be a replica-set-enabled deployment (even a
  single-member replica set is sufficient) — always use the project's compose stack, not an ad hoc
  container.
- **A misconfigured single-member replica set can advertise an internal-only hostname.** If the
  replica set is initialized with the wrong host identity, host-side tooling (tests run outside
  Docker) can fail to resolve that hostname even though the container itself works fine — this
  looks like a connectivity bug but is actually a replica-set config issue.
- **Why a transaction instead of application-level cleanup:** if the process crashed after the
  collection document was deleted but before the movie cascade ran, an ad hoc two-step delete would
  leave orphaned movie documents pointing at a `collectionId` that no longer exists. Wrapping both
  writes in one transaction means MongoDB rolls back the whole operation automatically on a crash
  or abort — there is no partially-deleted state to clean up later.
- **The repository keeps a raw `mongodb::Client` (not just `Database`) specifically to start
  sessions.** `MongoCollectionRepository::new()` extracts `db.client().clone()` — if a future
  refactor drops that field because it looks unused for the read paths, transactional delete breaks.

See [mc-service](/openwiki/projects/mc-service.md) for the repository's place in the Clean
Architecture layering, and
[MongoDB indexes and uniqueness](/openwiki/gotchas/mongodb-indexes-and-uniqueness.md) for the other
Mongo-level invariants this same adapter layer relies on.
