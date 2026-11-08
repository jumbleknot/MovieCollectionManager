# Plan 094: The downscoped-token cache is keyed by the token presented

**Spec**: [spec.md](./spec.md)

## Approach

- `DownscopedTokenCache.get` and `put` take the subject token. The key becomes
  `(user_id, audience, sha256(subject_token))`. `user_id` stays in the key so entries remain readable
  per user, but it no longer decides a hit on its own.
- `put` drops expired entries before inserting (FR-004). Entries live at most the exchanged token's TTL
  (60 s) minus the skew, so the map holds roughly one entry per run active in the last minute.
- `acquire_downscoped_token` passes `subject_token` through. Its only callers are `runtime_nodes._make_acquire`
  and the unit tests, so no other call site changes.

## Tests

`tests/unit/test_identity.py`:

- a forged token with the same `sub` misses the cache and reaches `authorize` and `exchange`;
- the stored key does not contain the raw subject token;
- an expired entry is pruned when another is stored.

## Rollback

Revert the merge. The cache is in memory only; no data or schema change.
