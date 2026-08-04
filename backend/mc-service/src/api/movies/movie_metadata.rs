use axum::{response::IntoResponse, Json};

use crate::application::dtos::movie_dto::MovieMetadataDto;

/// `GET /api/v1/movie-metadata` — the option values this service accepts for a movie.
///
/// Added by feature 047 US4 ([RQ-4]) so the conversational assistant can ask the DOMAIN which
/// media formats it accepts rather than holding a copy of them — the constitution's *No Domain
/// Logic in Agents*. The same set governs both `ownedMedia` and `ripQuality`.
///
/// **No per-handler role guard.** The route is nested inside the `protected` router, so
/// `auth_layer` then `require_app_role` have already run; role enforcement is a layer here, not
/// a per-handler check (openwiki/gotchas/role-enforcement-is-a-layer.md).
///
/// **Not collection-scoped and carrying no user data**, so no DAC check applies — it serialises
/// a domain enum and nothing else. That is also what makes the agent's process-wide TTL cache
/// safe: a response cached against one member's request and served to another leaks nothing.
///
/// Deliberately NOT the existing `filter-options` endpoint, which reports the values *observed*
/// in one collection — an empty collection would return nothing and a collection of DVDs would
/// hide Blu-Ray. This answers "what may I choose", not "what can I filter by here".
#[tracing::instrument]
pub async fn get_movie_metadata() -> axum::response::Response {
    Json(MovieMetadataDto::from_domain()).into_response()
}
