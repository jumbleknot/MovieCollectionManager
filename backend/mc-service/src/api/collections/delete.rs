use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension,
};
use axum_keycloak_auth::decode::KeycloakToken;

use crate::api::middleware::{auth::Role, error_handler::domain_error_to_response};
use crate::api::state::AppState;
use crate::application::commands::delete_collection::DeleteCollectionCommand;

/// `DELETE /api/v1/collections/:id` — delete a collection and all its movies.
#[tracing::instrument(skip(state))]
pub async fn delete_collection(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let cmd = DeleteCollectionCommand {
        collection_id: id.clone(),
        owner_id: owner_id.clone(),
    };

    match state.delete_collection.handle(cmd).await {
        Ok(()) => {
            tracing::info!(
                collection_id = %id,
                owner_id = %owner_id,
                "collection_deleted"
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => domain_error_to_response(e),
    }
}
