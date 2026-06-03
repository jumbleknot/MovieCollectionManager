use axum::{http::StatusCode, response::Response, Extension};
use metrics_exporter_prometheus::PrometheusHandle;

/// `GET /metrics` — Prometheus-compatible scrape endpoint.
///
/// Returns metrics in Prometheus text exposition format (version 0.0.4).
/// This endpoint is PUBLIC — Prometheus scrapers do not authenticate.
/// Must be on the `public` sub-router, NOT behind `KeycloakAuthLayer`.
///
/// Content-Type: text/plain; version=0.0.4
#[tracing::instrument(skip(handle))]
pub async fn metrics_handler(Extension(handle): Extension<PrometheusHandle>) -> Response<String> {
    let body = handle.render();

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/plain; version=0.0.4")
        .body(body)
        .expect("metrics response construction must not fail")
}
