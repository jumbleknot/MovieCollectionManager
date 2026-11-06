# Spec 091: Align the malformed-token test with axum-keycloak-auth 0.8.4

**Status**: Implementing | **Date**: 2026-11-06

## Problem

Renovate's Cargo lock maintenance (#946) moved `axum-keycloak-auth` from 0.8.3 to 0.8.4. That release
changes how a token that is not a JWT is rejected: `401` with the generic body
`{"error":"invalid_token"}`, where 0.8.3 answered `400` with the parse error in the body. Upstream lists
this under Security.

`movie_metadata_rejects_a_malformed_token` pins the old `400`, so `app-e2e` fails at
`mc-service-integration` on `main` and on every open pull request. The failure stops the job before the
web E2E suite runs. It reached `main` because a Cargo-only PR skips `app-e2e` by design.

## Requirements

- **FR-001**: The test MUST assert `401` for a token that is not a JWT.
- **FR-002**: The test MUST still prove the layer tried to decode the token. `401` alone cannot, because
  a request with no credential also gets `401`, so it MUST also assert the `invalid_token` body.
- **FR-003**: `axum-keycloak-auth` MUST stay on 0.8.4. Pinning it back would give up its security fixes.
- **FR-004**: No production code changes.

## Success criteria

- **SC-001**: `mc-service-integration` passes in CI, and `app-e2e` goes on to run the web E2E suite.

## Out of scope

- Adopting 0.8.4's optional `ValidationPolicy::strict()`.
- Changing the path gate that lets a Cargo-only PR skip `app-e2e`. That is a deliberate, documented
  decision in `.forgejo/workflows/app-ci.yml`, so changing it is a separate question.
