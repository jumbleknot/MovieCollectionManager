use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::IntoResponse, Extension, Json};
use axum_keycloak_auth::decode::KeycloakToken;

use crate::api::middleware::{auth::Role, error_handler::domain_error_to_response};
use crate::api::state::AppState;
use crate::application::commands::create_collection::CreateCollectionCommand;
use crate::application::dtos::collection_dto::CreateCollectionDto;

/// `POST /api/v1/collections` — create a new collection for the authenticated user.
#[tracing::instrument(skip(state))]
pub async fn create_collection(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
    Json(dto): Json<CreateCollectionDto>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let cmd = CreateCollectionCommand { owner_id, dto };

    match state.create_collection.handle(cmd).await {
        Ok(collection) => {
            tracing::info!(
                collection_id = %collection.id,
                owner_id = %collection.owner_id,
                "collection_created"
            );
            (StatusCode::CREATED, Json(collection)).into_response()
        }
        Err(e) => domain_error_to_response(e),
    }
}
