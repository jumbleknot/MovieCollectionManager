use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use axum_keycloak_auth::decode::KeycloakToken;

use crate::api::middleware::{auth::Role, error_handler::domain_error_to_response};
use crate::api::state::AppState;
use crate::application::commands::update_movie::UpdateMovieCommand;
use crate::application::dtos::movie_dto::UpdateMovieDto;

/// `PUT /api/v1/collections/:id/movies/:movieId` — full replacement update of a movie.
#[tracing::instrument(skip(state))]
pub async fn update_movie(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
    Path((collection_id, movie_id)): Path<(String, String)>,
    Json(dto): Json<UpdateMovieDto>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let cmd = UpdateMovieCommand {
        collection_id,
        movie_id,
        owner_id: owner_id.clone(),
        dto,
    };

    match state.update_movie.handle(cmd).await {
        Ok(movie) => {
            tracing::info!(
                movie_id = %movie.id,
                collection_id = %movie.collection_id,
                owner_id = %owner_id,
                "movie_updated"
            );
            Json(movie).into_response()
        }
        Err(e) => domain_error_to_response(e),
    }
}
