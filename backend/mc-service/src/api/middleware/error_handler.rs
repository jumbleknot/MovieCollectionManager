use axum::{
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use serde_json::json;

use crate::domain::errors::DomainError;

/// RFC 9457 Problem Details response.
pub fn problem_response(
    status: StatusCode,
    error_type: &str,
    title: &str,
    detail: &str,
) -> Response {
    let body = json!({
        "type": format!("https://mc-service.jumbleknot.net/errors/{}", error_type),
        "title": title,
        "status": status.as_u16(),
        "detail": detail,
    });

    (
        status,
        [("Content-Type", "application/problem+json")],
        Json(body),
    )
        .into_response()
}

/// Map a `DomainError` to an RFC 9457 Problem Details HTTP response.
pub fn domain_error_to_response(err: DomainError) -> Response {
    match err {
        DomainError::CollectionNotFound => problem_response(
            StatusCode::NOT_FOUND,
            "COLLECTION_NOT_FOUND",
            "Collection not found",
            "The requested collection does not exist or you do not have access to it.",
        ),
        DomainError::MovieNotFound => problem_response(
            StatusCode::NOT_FOUND,
            "MOVIE_NOT_FOUND",
            "Movie not found",
            "The requested movie does not exist in this collection.",
        ),
        DomainError::DuplicateCollectionName => problem_response(
            StatusCode::CONFLICT,
            "DUPLICATE_COLLECTION_NAME",
            "Duplicate collection name",
            "A collection with this name already exists.",
        ),
        DomainError::DuplicateMovie => problem_response(
            StatusCode::CONFLICT,
            "DUPLICATE_MOVIE",
            "Duplicate movie",
            "A movie with this title, year, and content type already exists in this collection.",
        ),
        DomainError::ValidationError(msg) => problem_response(
            StatusCode::BAD_REQUEST,
            "INVALID_INPUT",
            "Invalid input",
            &msg,
        ),
        DomainError::OwnedMediaWhenNotOwned => problem_response(
            StatusCode::BAD_REQUEST,
            "OWNED_MEDIA_WHEN_NOT_OWNED",
            "Invalid owned media",
            "ownedMedia must be empty when owned is false.",
        ),
        DomainError::RipQualityWhenNotRipped => problem_response(
            StatusCode::BAD_REQUEST,
            "RIP_QUALITY_WHEN_NOT_RIPPED",
            "Invalid rip quality",
            "ripQuality must be empty when ripped is false.",
        ),
        DomainError::AccessDenied => {
            tracing::warn!("access_denied: domain rule rejected request — 403 Forbidden");
            problem_response(
                StatusCode::FORBIDDEN,
                "ACCESS_DENIED",
                "Access denied",
                "You do not have permission to perform this action.",
            )
        }
        DomainError::Internal(msg) => {
            tracing::error!(error = %msg, "Internal error");
            problem_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "Internal server error",
                "An unexpected error occurred. Please try again later.",
            )
        }
    }
}
