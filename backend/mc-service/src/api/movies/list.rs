use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::IntoResponse,
    Extension, Json,
};
use axum_keycloak_auth::decode::KeycloakToken;
use serde::Deserialize;

use crate::api::middleware::{auth::Role, error_handler::domain_error_to_response};
use crate::api::state::AppState;
use crate::application::ports::movie_repository::ListMoviesParams;
use crate::application::queries::list_movies::ListMoviesQuery;

#[derive(Debug, Deserialize)]
pub struct ListMoviesQueryParams {
    pub cursor: Option<String>,
    pub search: Option<String>,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
    pub genre: Option<String>, // single-value param; repeat for OR (e.g. &genre=Action&genre=Drama)
    pub childrens: Option<bool>,
    pub rated: Option<String>,
    pub language: Option<String>,
    pub decade: Option<i32>,
    pub owned: Option<bool>,
    // Single-value param: BFF sends ?ownedMedia=DVD (one chip at a time, matching
    // the genre pattern). The handler converts it to Vec<String> for the query.
    #[serde(rename = "ownedMedia")]
    pub owned_media: Option<String>,
    pub ripped: Option<bool>,
    // Same pattern as ownedMedia — single value, converted to Vec in handler.
    #[serde(rename = "ripQuality")]
    pub rip_quality: Option<String>,
}

/// `GET /api/v1/collections/:id/movies` — list movies with optional search, filter, and cursor.
#[tracing::instrument(skip(state))]
pub async fn list_movies(
    State(state): State<Arc<AppState>>,
    Extension(token): Extension<KeycloakToken<Role>>,
    Path(collection_id): Path<String>,
    Query(params): Query<ListMoviesQueryParams>,
) -> axum::response::Response {
    let owner_id = token.subject.to_string();
    let query = ListMoviesQuery {
        collection_id,
        owner_id,
        params: ListMoviesParams {
            cursor: params.cursor,
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

    match state.list_movies.handle(query).await {
        Ok(result) => Json(result).into_response(),
        Err(e) => domain_error_to_response(e),
    }
}
