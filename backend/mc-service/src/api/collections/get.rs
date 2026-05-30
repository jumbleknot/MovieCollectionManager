use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use axum_keycloak_auth::decode::KeycloakToken;

use crate::api::middleware::{auth::Role, error_handler::domain_error_to_response};
use crate::api::state::AppState;
use crate::application::queries::get_collection::GetCollectionQuery;

/// `GET /api/v1/collections/:id` — get a specific collection by ID.
#[tracing::instrument(skip(state))]
pub async fn get_collection(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let query = GetCollectionQuery {
        collection_id: id,
        owner_id,
    };

    match state.get_collection.handle(query).await {
        Ok(collection) => Json(collection).into_response(),
        Err(e) => domain_error_to_response(e),
    }
}
