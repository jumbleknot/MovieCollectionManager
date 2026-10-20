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
        // RFC 9457 problem-type identifier — a stable, non-resolvable namespace under the
        // reserved `.example` TLD (RFC 2606); intentionally not the deployment domain.
        "type": format!("https://mc-service.example/errors/{}", error_type),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 081 US9 PR 9a: the problem body's key ORDER is part of the bytes on the wire. It was
    /// insertion order only because bson 2 switched on serde_json's `preserve_order`; bson 3 does
    /// not, so without this crate naming the feature the body silently went alphabetical.
    #[tokio::test]
    async fn problem_body_keeps_rfc_9457_member_order_on_the_wire() {
        let resp = problem_response(StatusCode::NOT_FOUND, "not-found", "Not Found", "gone");
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("body");
        assert_eq!(
            std::str::from_utf8(&bytes).expect("utf8"),
            r#"{"type":"https://mc-service.example/errors/not-found","title":"Not Found","status":404,"detail":"gone"}"#
        );
    }
}
