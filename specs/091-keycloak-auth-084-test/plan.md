# Plan 091: Align the malformed-token test with axum-keycloak-auth 0.8.4

**Spec**: [spec.md](./spec.md)

## Approach

Update the one failing test and its comment in
`backend/mc-service/tests/integration/movies/movie_metadata_test.rs`. It is the only `mc-service` test
that pins `400` from the auth layer.

## What was checked in 0.8.4

| Question | Finding |
|---|---|
| Why did the status change? | Intended. The 0.8.4 changelog lists it under Security. |
| Do other tests depend on the old answers? | No. Every other auth assertion expects `401` or `403`, which 0.8.4 keeps. |
| Does `mc-service` rely on the library's log lines? | No. `api/middleware/logging.rs` logs `auth_failure` on any `401`, so malformed tokens are now logged where the old `400` was not. |
| Does the layer still block? | Yes. `mc-service` sets `PassthroughMode::Block`. |

## Verification

This test needs Keycloak and MongoDB. CI's `mc-service-integration` step is the verification, because the
stacks running in this dev container belong to other sessions.

`cargo test` stops at the first failing test binary, so `pool_test` has not run against 0.8.4 yet. CI will
run it once this test passes.

## Rollback

Revert the merge. `main` then fails `app-e2e` again as it does today, unless the lockfile is reverted too.
