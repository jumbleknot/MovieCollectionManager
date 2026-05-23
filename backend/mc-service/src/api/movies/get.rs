use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use axum_keycloak_auth::decode::KeycloakToken;

use crate::api::middleware::{auth::Role, error_handler::domain_error_to_response};
use crate::api::state::AppState;
use crate::application::queries::get_movie::GetMovieQuery;

/// `GET /api/v1/collections/:id/movies/:movieId` — get a specific movie.
#[tracing::instrument(skip(state))]
pub async fn get_movie(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
    Path((collection_id, movie_id)): Path<(String, String)>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let query = GetMovieQuery {
        collection_id,
        movie_id,
        owner_id,
    };

    match state.get_movie.handle(query).await {
        Ok(movie) => Json(movie).into_response(),
        Err(e) => domain_error_to_response(e),
    }
}
