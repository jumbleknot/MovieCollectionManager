use std::sync::Arc;

use axum::{extract::State, response::Json, Extension};
use axum_keycloak_auth::decode::KeycloakToken;

use crate::api::middleware::{auth::Role, error_handler::domain_error_to_response};
use crate::api::state::AppState;
use crate::application::queries::list_collections::ListCollectionsQuery;

/// `GET /api/v1/collections` — list all collections for the authenticated user.
#[tracing::instrument(skip(state))]
pub async fn list_collections(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let query = ListCollectionsQuery { owner_id };

    match state.list_collections.handle(query).await {
        Ok(collections) => Json(collections).into_response(),
        Err(e) => domain_error_to_response(e),
    }
}

use axum::response::IntoResponse;
