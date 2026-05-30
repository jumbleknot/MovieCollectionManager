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
use crate::application::commands::delete_movie::DeleteMovieCommand;

/// `DELETE /api/v1/collections/:id/movies/:movieId` — permanently delete a movie.
#[tracing::instrument(skip(state))]
pub async fn delete_movie(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
    Path((collection_id, movie_id)): Path<(String, String)>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let cmd = DeleteMovieCommand {
        collection_id: collection_id.clone(),
        movie_id: movie_id.clone(),
        owner_id: owner_id.clone(),
    };

    match state.delete_movie.handle(cmd).await {
        Ok(()) => {
            tracing::info!(
                movie_id = %movie_id,
                collection_id = %collection_id,
                owner_id = %owner_id,
                "movie_deleted"
            );
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => domain_error_to_response(e),
    }
}
