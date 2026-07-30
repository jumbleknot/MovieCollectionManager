---
type: Gotcha
title: mc-service errors are RFC 9457 Problem Details, never a stack trace
description: mc-service maps every DomainError to an application/problem+json response via problem_response() — a stable RFC 9457 body with a non-resolvable .example type URI — and never serializes a Rust panic or error stack trace to the client.
resource: backend/mc-service/src/api/middleware/error_handler.rs
tags: [mc-service, rust, axum, error-handling, api]
timestamp: 2026-07-27T00:00:00-04:00
---

# mc-service errors are RFC 9457 Problem Details, never a stack trace

Every `DomainError` mc-service raises is converted to an HTTP response by
`domain_error_to_response()` in `error_handler.rs`, which calls the shared `problem_response()`
helper. The response is `application/problem+json` per [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457):
a JSON body with `type`, `title`, `status`, and `detail` fields, never a bare error string and never
a stack trace.

## Gotchas

- **`type` is a stable, non-resolvable URI under `.example`, not the deployment domain.**
  `problem_response()` builds it as `https://mc-service.example/errors/{ERROR_CODE}` (RFC 2606
  reserves `.example` for exactly this). Do not "fix" this by pointing it at the real service
  hostname — that would leak deployment topology into an API contract field that clients may
  persist or log.
- **`detail` is a fixed, hand-written message per error variant, never the underlying error's
  `Display` output.** `DomainError::Internal(msg)` logs `msg` via `tracing::error!` server-side but
  returns the generic "An unexpected error occurred. Please try again later." to the client — the
  internal message never crosses the response boundary. Any new `DomainError` variant must follow
  the same split: log detail server-side, return a safe fixed `detail` client-side.
- **There is no fallback path that serializes a panic or Rust backtrace to the client.** Every
  variant of `DomainError` is exhaustively matched in `domain_error_to_response()`, so adding a new
  domain error without a matching arm is a compile error, not a code path that could leak internals
  through an unhandled case.
- **The error-code string (`COLLECTION_NOT_FOUND`, `VALIDATION_ERROR`, …) is the stable machine-
  readable identifier, not `title` or `detail`.** Clients and tests should match on the `type` URI's
  trailing segment or a dedicated code field if one is added later — `title`/`detail` text is meant
  for humans and is free to be reworded.

See [mc-service](/openwiki/projects/mc-service.md) for the Clean Architecture layering that produces
`DomainError` in the application/domain layers before this API-layer handler ever sees it.
