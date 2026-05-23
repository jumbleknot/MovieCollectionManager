use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use axum_keycloak_auth::decode::KeycloakToken;

use crate::api::middleware::{auth::Role, error_handler::domain_error_to_response};
use crate::api::state::AppState;
use crate::application::commands::set_default_collection::SetDefaultCollectionCommand;
use crate::application::commands::update_collection::UpdateCollectionCommand;
use crate::application::dtos::collection_dto::UpdateCollectionDto;

/// `PATCH /api/v1/collections/:id` — partially update a collection.
/// If `isDefault: true` is included, also dispatches the set-default command atomically.
#[tracing::instrument(skip(state))]
pub async fn update_collection(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
    Path(id): Path<String>,
    Json(dto): Json<UpdateCollectionDto>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let set_default = dto.is_default == Some(true);

    if set_default {
        let cmd = SetDefaultCollectionCommand {
            collection_id: id.clone(),
            owner_id: owner_id.clone(),
        };
        if let Err(e) = state.set_default_collection.handle(cmd).await {
            return domain_error_to_response(e);
        }
    }

    let cmd = UpdateCollectionCommand {
        collection_id: id,
        owner_id,
        dto,
    };
    match state.update_collection.handle(cmd).await {
        Ok(collection) => {
            tracing::info!(
                collection_id = %collection.id,
                owner_id = %collection.owner_id,
                set_default = set_default,
                "collection_updated"
            );
            Json(collection).into_response()
        }
        Err(e) => domain_error_to_response(e),
    }
}
