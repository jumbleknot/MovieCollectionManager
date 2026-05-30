use axum::{http::StatusCode, response::Json};
use serde_json::{json, Value};

/// `GET /health` — public endpoint for load balancer and orchestrator health checks.
/// Returns `{"status":"ok"}` with HTTP 200. No auth required.
#[tracing::instrument]
pub async fn health_handler() -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(json!({ "status": "ok" })))
}
