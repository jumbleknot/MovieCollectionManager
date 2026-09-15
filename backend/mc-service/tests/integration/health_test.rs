/// T009  — RED: GET /health returns 200 {"status":"ok"}, no auth required
/// T009b — RED: Protected routes return 401 without a valid JWT (centralized auth)
/// T015b — RED: Logging middleware emits valid JSON log line with required fields
/// T163a — RED: GET /metrics returns 200 with Prometheus exposition format, no auth required
///
/// These tests are RED until the router, health handler, auth layer, logging
/// middleware, and metrics endpoint are all wired together correctly in router.rs.
mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt; // oneshot // collect()

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Build the Axum app for integration testing without a real MongoDB or Keycloak.
/// Uses the test DB from common::test_db() and overrides auth for testing.
///
/// NOTE: T009 / T009b / T015b test the *real* router with a real test MongoDB.
/// Keycloak auth is bypassed only for the public /health endpoint tests.
/// For protected route tests we assert on the 401 response — no valid JWT is provided.
///
/// `common::build_test_app` waits for JWKS discovery before returning — see its docs.
use common::build_test_app;

// ── T009: Health endpoint ─────────────────────────────────────────────────────

/// GET /health returns 200 with {"status":"ok"} — no auth required.
#[tokio::test]
async fn health_returns_200() {
    let app = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::OK,
        "GET /health must return 200"
    );

    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let json: Value = serde_json::from_slice(&bytes).expect("Response must be valid JSON");
    assert_eq!(json["status"], "ok", r#"Body must be {{"status":"ok"}}"#);
}

/// GET /health is reachable WITHOUT a JWT (public sub-router, no auth layer).
#[tokio::test]
async fn health_is_public_no_auth_required() {
    let app = build_test_app().await;

    // No Authorization header — public route must not require auth
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_ne!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "GET /health must not require authentication"
    );
    assert_eq!(response.status(), StatusCode::OK);
}

// ── T009b: Centralized auth enforcement ──────────────────────────────────────

/// Protected routes return 401 when no JWT is provided.
/// This verifies that `KeycloakAuthLayer` is applied centrally on the protected
/// sub-router — no per-handler auth code is needed.
#[tokio::test]
async fn protected_routes_require_auth() {
    let app = build_test_app().await;

    let protected_endpoints = vec![
        ("GET", "/api/v1/collections"),
        ("POST", "/api/v1/collections"),
        ("GET", "/api/v1/collections/some-id"),
        ("PATCH", "/api/v1/collections/some-id"),
        ("DELETE", "/api/v1/collections/some-id"),
        ("GET", "/api/v1/collections/some-id/movies"),
        ("POST", "/api/v1/collections/some-id/movies"),
        ("GET", "/api/v1/collections/some-id/movies/filter-options"),
        ("GET", "/api/v1/collections/some-id/movies/some-movie-id"),
        ("PUT", "/api/v1/collections/some-id/movies/some-movie-id"),
        ("DELETE", "/api/v1/collections/some-id/movies/some-movie-id"),
    ];

    for (method, path) in protected_endpoints {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path} must return 401 without a JWT — centralized auth not applied"
        );
    }
}

// ── T163a: Prometheus /metrics endpoint ──────────────────────────────────────

/// GET /metrics returns 200 with Prometheus exposition format.
///
/// Requirements:
/// - HTTP 200 OK
/// - Content-Type header contains "text/plain" and Prometheus version "0.0.4"
/// - Body is valid Prometheus exposition text (lines starting with # or metric_name)
/// - No stack traces or internal error messages in response body
/// - Endpoint is PUBLIC (no auth required — Prometheus scraper does not send JWTs)
#[tokio::test]
async fn metrics_returns_200_with_prometheus_format() {
    let app = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/metrics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::OK,
        "GET /metrics must return 200 OK"
    );

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    assert!(
        content_type.contains("text/plain"),
        "Content-Type must contain 'text/plain', got: {content_type}"
    );
    assert!(
        content_type.contains("0.0.4"),
        "Content-Type must contain Prometheus version '0.0.4', got: {content_type}"
    );

    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let body = String::from_utf8_lossy(&bytes);

    // An empty body is valid Prometheus exposition format (no metrics recorded yet).
    // In integration tests the global recorder may not be the first to be installed
    // (other tests in the same binary call router::build() first), so the fallback
    // isolated recorder returns an empty body. Both empty and non-empty responses
    // are valid as long as they don't contain error/panic text.
    assert!(
        !body.contains("panicked"),
        "GET /metrics must not expose panic messages: {body}"
    );
    assert!(
        !body.contains("stack backtrace"),
        "GET /metrics must not expose stack traces: {body}"
    );

    // If the body is non-empty, every line must conform to Prometheus text exposition format:
    // lines must start with '#' (comment/TYPE/HELP), be empty, or be a metric name (alpha/_).
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue; // empty lines are allowed per the Prometheus format
        }
        assert!(
            trimmed.starts_with('#')
                || trimmed
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_alphabetic() || c == '_'),
            "Non-conforming Prometheus text exposition line: '{trimmed}'"
        );
    }
}

/// GET /metrics is reachable WITHOUT a JWT (public sub-router, no auth layer).
#[tokio::test]
async fn metrics_is_public_no_auth_required() {
    let app = build_test_app().await;

    // No Authorization header — public route must not require auth
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/metrics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_ne!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "GET /metrics must not require authentication — Prometheus scraper uses no JWT"
    );
    assert_ne!(
        response.status(),
        StatusCode::NOT_FOUND,
        "GET /metrics endpoint must exist and be reachable"
    );
    assert_eq!(response.status(), StatusCode::OK);
}

// ── T015b: Logging middleware JSON output ─────────────────────────────────────

/// GET /health produces a valid JSON log line containing the required fields.
///
/// This test captures tracing subscriber output and verifies the structured log
/// emitted by `logging_middleware` in response to a request.
///
/// Fields required (per tasks.md T015b):
///   - `request_id`  — UUID string
///   - `method`      — "GET"
///   - `path`        — "/health"
///   - `status`      — 200 (numeric)
///   - `duration_ms` — numeric
///
/// Shape note: `logging_middleware` puts `request_id` / `method` / `path` on the
/// `request` **span** and emits a `request completed` **event** carrying `status`
/// and `duration_ms`. That split is the documented contract — openwiki
/// `invariants/logging-and-audit.md`: "correlation via a per-request `request_id`
/// span" — so the assertions below read the span and the event separately.
///
/// (This test previously carried an `#[ignore]` blaming a global-subscriber
/// conflict. It was also asserting a flat `message == "request"` line the
/// middleware never emitted — that half was a real fix.
///
/// The other half — "there is no global subscriber anywhere in src/ or tests/",
/// therefore a subscriber conflict was not the problem — was WRONG, and removing
/// the `#[ignore]` on the strength of it reintroduced a flake that then hid for
/// months behind `--test-threads=1`. The conflict is not a competing subscriber;
/// it is `tracing`'s GLOBAL callsite-`Interest` cache being set to `never()` by a
/// thread that has no subscriber, which suppresses the event on the thread that
/// does. Measured 2026-09-15 (item #462): 2/3 whole-binary runs failed, 3/3 passed
/// serially. See `common::log_capture` for the mechanism and the fix.)
#[tokio::test]
async fn logging_middleware_emits_structured_json() {
    // A COMPETING THREAD IS PART OF THIS TEST, NOT INCIDENTAL TO IT (item #462).
    //
    // It drives the same `logging_middleware` callsite with no subscriber installed — exactly what a
    // concurrently-running test in this binary does. Against the old `set_default` capture this
    // reproduced the flake 5 times out of 5, turning a 2-in-3 heisenbug into a deterministic one.
    // Keeping it means this test now asserts the property that actually matters: capture works
    // WHILE the rest of the binary is running, which is the only way it is ever really used.
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_for_thread = std::sync::Arc::clone(&stop);
    let noisy_neighbour = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("noisy-neighbour runtime");
        rt.block_on(async {
            while !stop_for_thread.load(std::sync::atomic::Ordering::Relaxed) {
                let app = axum::Router::new()
                    .route("/health", axum::routing::get(|| async { "ok" }))
                    .layer(axum::middleware::from_fn(
                        mc_service::api::middleware::logging::logging_middleware,
                    ));
                let _ = app
                    .oneshot(
                        Request::builder()
                            .uri("/health")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await;
            }
        });
    });

    // Capture THIS thread's events through the binary's one global subscriber. Deliberately not
    // `tracing::subscriber::set_default` — a thread-local dispatcher is precisely what the noisy
    // neighbour above defeats. See `common::log_capture`.
    let capture = common::log_capture::capture();

    let app = build_test_app().await;
    let _ = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    noisy_neighbour.join().expect("noisy neighbour panicked");

    // Find the request-completion event emitted by logging_middleware.
    let parsed: Vec<Value> = capture.json();

    let request_line = parsed
        .iter()
        .find(|v| v["fields"]["message"] == "request completed")
        .unwrap_or_else(|| {
            panic!(
                "logging_middleware must emit a JSON event with message='request completed'; \
                 captured lines: {}",
                serde_json::to_string_pretty(&parsed).unwrap_or_default()
            )
        });

    // Event-level fields.
    let fields = &request_line["fields"];
    assert_eq!(
        fields["status"].as_u64().unwrap_or(0),
        200,
        "status field must be 200"
    );
    assert!(
        fields["duration_ms"].is_number(),
        "duration_ms must be numeric, got line: {request_line}"
    );

    // Span-level correlation fields — the `request` span the event is nested in.
    let span = &request_line["span"];
    let request_id = span["request_id"].as_str().unwrap_or("");
    assert!(
        !request_id.is_empty(),
        "request_id must be present on the request span, got line: {request_line}"
    );
    assert!(
        uuid::Uuid::parse_str(request_id).is_ok(),
        "request_id must be a valid UUID, got: {request_id}"
    );
    assert_eq!(
        span["method"].as_str().unwrap_or(""),
        "GET",
        "method must be 'GET' on the request span"
    );
    assert_eq!(
        span["path"].as_str().unwrap_or(""),
        "/health",
        "path must be '/health' on the request span"
    );
}

// ── Readiness gate — why it must assert success, not merely yield ─────────────
//
// PRD-McServiceHttpAuthzIntegration §3.1a. These two tests exist to stop the
// readiness gate in `common::build_test_app` from being "simplified" away. The
// auth-negative suite above is only meaningful because the gate holds.

/// Build the protected-router wiring against an arbitrary Keycloak URL.
fn mini_protected_app(
    instance: std::sync::Arc<axum_keycloak_auth::instance::KeycloakAuthInstance>,
    audience: &str,
) -> axum::Router {
    use axum_keycloak_auth::{layer::KeycloakAuthLayer, PassthroughMode};
    use mc_service::api::middleware::auth::Role;

    let auth_layer = KeycloakAuthLayer::<Role>::builder()
        .instance(instance)
        .passthrough_mode(PassthroughMode::Block)
        .persist_raw_claims(false)
        .expected_audiences(vec![audience.to_string()])
        .build();

    let protected = axum::Router::new()
        .route(
            "/collections",
            axum::routing::get(|| async { "unreachable" }),
        )
        .layer(axum::middleware::from_fn(
            mc_service::api::middleware::auth::require_app_role,
        ))
        .layer(auth_layer);

    axum::Router::new().nest("/api/v1", protected)
}

fn unreachable_keycloak_instance(
) -> std::sync::Arc<axum_keycloak_auth::instance::KeycloakAuthInstance> {
    use axum_keycloak_auth::instance::{KeycloakAuthInstance, KeycloakConfig};

    // Port 1 → connection refused. One attempt so discovery settles immediately.
    let kc_config = KeycloakConfig::builder()
        .server("http://127.0.0.1:1".parse().unwrap())
        .realm("unreachable".to_string())
        .retry((1, 1))
        .build();
    std::sync::Arc::new(KeycloakAuthInstance::new(kc_config))
}

/// THE FALSE GREEN THIS GUARDS AGAINST: with a completely unreachable Keycloak,
/// OIDC discovery ends in `Err` — but `discovery.version()` is incremented anyway,
/// so the auth service reports ready and an unauthenticated request still gets a
/// 401. Every `*_returns_401_without_jwt` test above would therefore pass with no
/// identity provider at all, if it did not wait for discovery to *succeed*.
#[tokio::test]
async fn unauthenticated_401_is_returned_even_when_keycloak_is_unreachable() {
    let instance = unreachable_keycloak_instance();
    let app = mini_protected_app(instance.clone(), "movie-collection-manager");

    // Let the discovery task start; the request then waits on its (failed) completion.
    tokio::task::yield_now().await;

    let status = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/v1/collections")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
        .status();

    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "401 without JWKS — this is exactly why build_test_app gates on is_operational()"
    );
    assert!(
        !instance.is_operational().await,
        "discovery against a dead Keycloak must not report operational"
    );
}

/// ...and the gate catches it: it reports not-operational rather than letting the
/// suite proceed, so a broken Keycloak fails loudly instead of passing green.
#[tokio::test]
async fn readiness_gate_reports_not_operational_for_unreachable_keycloak() {
    let instance = unreachable_keycloak_instance();

    let ready = common::wait_until_operational(&instance, std::time::Duration::from_secs(2)).await;

    assert!(
        !ready,
        "the readiness gate must refuse to proceed when Keycloak is unreachable"
    );
}
