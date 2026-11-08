# Tasks 094: The downscoped-token cache is keyed by the token presented

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [X] **T001** Add the cache-key tests (FR-001, FR-002, FR-004).
  **Verify RED**: the forged-token, raw-token and prune cases fail; the existing cases pass.
- [X] **T002** Key the cache by the subject-token digest and prune on `put`.
  **Verify GREEN**: the same tests pass, with the movie-assistant unit suite and lint.
- [X] **T003** Open the PR and get green CI. **Quote** the run numbers.

## Evidence

| Task | Result | Run |
|---|---|---|
| T001 RED | `3 failed, 5 passed`: `test_forged_token_with_same_sub_misses_the_cache`, `test_cache_does_not_hold_the_raw_subject_token`, `test_put_prunes_expired_entries`. The existing cache, skew, denial and failure cases passed | Local |
| T002 GREEN | `test_identity.py`: `8 passed`. `pnpm nx run-many -t lint,test -p movie-assistant`: 2 succeeded (unit suite `1237 passed, 1 skipped`; ruff and mypy clean) | Local |
| T003 | `ci-status.mjs status --pr 965`, head `2e81645b21c2b7c772a2fea156001f65f409444b`: `VERDICT mergeable — all required contexts satisfied`, 12/12 required contexts passed (advisory `dast`, `android-launch` passed; `trigger-cd` path-gated). Run ids 7156 `app-ci`, 7157 `guardrails`, 7158 `infra-image-scan` (the web UI shows them as `/actions/runs/7155`–`7157`, its `index_in_repo`). Merged as `62fa60aa`; ticked in spec 097 | CI, PR #965 |
