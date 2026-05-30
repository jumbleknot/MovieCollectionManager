use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension, Json,
};
use axum_keycloak_auth::decode::KeycloakToken;

use crate::api::middleware::{auth::Role, error_handler::domain_error_to_response};
use crate::api::state::AppState;
use crate::application::commands::create_movie::CreateMovieCommand;
use crate::application::dtos::movie_dto::CreateMovieDto;

/// `POST /api/v1/collections/:id/movies` — add a movie to a collection.
#[tracing::instrument(skip(state))]
pub async fn create_movie(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
    Path(collection_id): Path<String>,
    Json(dto): Json<CreateMovieDto>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let cmd = CreateMovieCommand {
        collection_id,
        owner_id: owner_id.clone(),
        dto,
    };

    match state.create_movie.handle(cmd).await {
        Ok(movie) => {
            tracing::info!(
                movie_id = %movie.id,
                collection_id = %movie.collection_id,
                owner_id = %owner_id,
                "movie_created"
            );
            (StatusCode::CREATED, Json(movie)).into_response()
        }
        Err(e) => domain_error_to_response(e),
    }
}
