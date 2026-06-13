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
    // 013 FR-003: optional server-applied sort. Whitelisted scalar column + direction.
    #[serde(rename = "sortBy")]
    pub sort_by: Option<String>,
    #[serde(rename = "sortDir")]
    pub sort_dir: Option<String>,
}

/// Scalar columns the movie list may be sorted by (013 FR-003).
const SORTABLE_FIELDS: [&str; 9] = [
    "title",
    "year",
    "contentType",
    "language",
    "owned",
    "ripped",
    "childrens",
    "rated",
    "runtime",
];

/// Whitelist-validate the sort params. Returns an error message for an invalid `sortBy`/`sortDir`
/// so the handler can answer 400 rather than silently ignoring a bad value (013 FR-003).
fn validate_sort(sort_by: Option<&str>, sort_dir: Option<&str>) -> Result<(), String> {
    if let Some(sb) = sort_by {
        if !SORTABLE_FIELDS.contains(&sb) {
            return Err(format!("Invalid sortBy: {sb}"));
        }
    }
    if let Some(sd) = sort_dir {
        if sd != "asc" && sd != "desc" {
            return Err(format!("Invalid sortDir: {sd}"));
        }
    }
    Ok(())
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

    if let Err(msg) = validate_sort(params.sort_by.as_deref(), params.sort_dir.as_deref()) {
        return domain_error_to_response(crate::domain::errors::DomainError::ValidationError(msg));
    }

    let query = ListMoviesQuery {
        collection_id,
        owner_id,
        params: ListMoviesParams {
            cursor: params.cursor,
            sort_by: params.sort_by,
            sort_dir: params.sort_dir,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_absent_sort_params() {
        assert!(validate_sort(None, None).is_ok());
    }

    #[test]
    fn accepts_each_whitelisted_field_and_direction() {
        for f in SORTABLE_FIELDS {
            assert!(validate_sort(Some(f), Some("asc")).is_ok(), "{f} asc");
            assert!(validate_sort(Some(f), Some("desc")).is_ok(), "{f} desc");
        }
    }

    #[test]
    fn rejects_unknown_sort_field() {
        let err = validate_sort(Some("genres"), Some("asc")).unwrap_err();
        assert!(err.contains("Invalid sortBy"), "got: {err}");
    }

    #[test]
    fn rejects_unknown_direction() {
        let err = validate_sort(Some("title"), Some("sideways")).unwrap_err();
        assert!(err.contains("Invalid sortDir"), "got: {err}");
    }
}
