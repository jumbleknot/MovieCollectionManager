use axum::{body::Body, extract::Request, middleware::Next, response::Response};
use std::time::Instant;
use tracing::Instrument;
use uuid::Uuid;

/// Per-request tracing middleware.
///
/// Generates a UUID `request_id` per request and creates a tracing span for the entire
/// request lifecycle. All child spans (handlers, repository calls) inherit `request_id`
/// automatically via the tracing subscriber.
///
/// Emits audit-level `warn` events for 401 (auth failure) and 403 (access denied)
/// to satisfy the constitution's Centralized Access Control observability requirement.
pub async fn logging_middleware(request: Request<Body>, next: Next) -> Response {
    let request_id = Uuid::new_v4().to_string();
    let method = request.method().clone();
    let path = request.uri().path().to_string();

    // Create a span that propagates request_id to all child spans and events.
    let span = tracing::info_span!(
        "request",
        request_id = %request_id,
        method = %method,
        path = %path,
    );

    let start = Instant::now();
    let response = next.run(request).instrument(span.clone()).await;
    let duration_ms = start.elapsed().as_millis();
    let status = response.status().as_u16();

    // Log completion inside the span so request_id appears on every line.
    let _enter = span.enter();
    tracing::info!(status = status, duration_ms = duration_ms, "request completed");

    // Audit events for security-relevant status codes.
    // 401: JWT missing, expired, or invalid signature — caught by KeycloakAuthLayer.
    // 403: Valid JWT but insufficient role or DomainError::AccessDenied.
    if status == 401 {
        tracing::warn!(status = 401, "auth_failure: 401 Unauthorized");
    } else if status == 403 {
        tracing::warn!(status = 403, "access_denied: 403 Forbidden");
    }

    response
}
