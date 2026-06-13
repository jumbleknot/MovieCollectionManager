use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Extension, Json,
};
use axum_keycloak_auth::decode::KeycloakToken;

use crate::api::middleware::{auth::Role, error_handler::domain_error_to_response};
use crate::api::movies::list::ListMoviesQueryParams;
use crate::api::state::AppState;
use crate::application::dtos::movie_dto::MovieCountDto;
use crate::application::ports::movie_repository::ListMoviesParams;
use crate::application::queries::count_movies::CountMoviesQuery;

/// `GET /api/v1/collections/:id/movies/count` — count movies matching the same filter params as
/// the list endpoint (the `cursor` param is ignored). Served by an efficient store-side count
/// (US4 / FR-023). DAC-gated at Viewer; a collection the caller cannot reach 404s like list/get.
#[tracing::instrument(skip(state))]
pub async fn count_movies(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
    Path(collection_id): Path<String>,
    Query(params): Query<ListMoviesQueryParams>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let query = CountMoviesQuery {
        collection_id,
        owner_id,
        params: ListMoviesParams {
            cursor: None, // count is total over all pages — pagination cursor is meaningless here
            sort_by: None, // count is order-independent
            sort_dir: None,
            search: params.search,
            content_type: params.content_type,
            genres: params.genre.map(|g| vec![g]).unwrap_or_default(),
            childrens: params.childrens,
            rated: params.rated,
            language: params.language,
            decade: params.decade,
            owned: params.owned,
            owned_media: params.owned_media.map(|m| vec![m]).unwrap_or_default(),
            ripped: params.ripped,
            rip_quality: params.rip_quality.map(|m| vec![m]).unwrap_or_default(),
        },
    };

    match state.count_movies.handle(query).await {
        Ok(count) => Json(MovieCountDto { count }).into_response(),
        Err(e) => domain_error_to_response(e),
    }
}
