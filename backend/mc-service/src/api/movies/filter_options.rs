use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use axum_keycloak_auth::decode::KeycloakToken;

use crate::api::middleware::{auth::Role, error_handler::domain_error_to_response};
use crate::api::state::AppState;
use crate::application::queries::get_filter_options::GetFilterOptionsQuery;

/// `GET /api/v1/collections/:id/movies/filter-options` — dynamic filter options for the collection.
#[tracing::instrument(skip(state))]
pub async fn get_filter_options(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
    Path(collection_id): Path<String>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let query = GetFilterOptionsQuery {
        collection_id,
        owner_id,
    };

    match state.get_filter_options.handle(query).await {
        Ok(options) => Json(options).into_response(),
        Err(e) => domain_error_to_response(e),
    }
}
