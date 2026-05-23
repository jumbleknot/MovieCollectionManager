/// Typed domain errors for mc-service.
/// These are translated into RFC 9457 Problem Details responses by the error handler.
#[derive(Debug, thiserror::Error, Clone, PartialEq)]
pub enum DomainError {
    #[error("A collection with this name already exists")]
    DuplicateCollectionName,

    #[error("A movie with this title, year, and content type already exists in this collection")]
    DuplicateMovie,

    #[error("Collection not found")]
    CollectionNotFound,

    #[error("Movie not found")]
    MovieNotFound,

    #[error("Validation error: {0}")]
    ValidationError(String),

    #[error("ownedMedia must be empty when owned is false")]
    OwnedMediaWhenNotOwned,

    #[error("ripQuality must be empty when ripped is false")]
    RipQualityWhenNotRipped,

    #[error("Access denied")]
    AccessDenied,

    #[error("Internal error: {0}")]
    Internal(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_errors_display_correctly() {
        assert_eq!(
            DomainError::DuplicateCollectionName.to_string(),
            "A collection with this name already exists"
        );
        assert_eq!(
            DomainError::CollectionNotFound.to_string(),
            "Collection not found"
        );
        assert_eq!(
            DomainError::ValidationError("name too long".to_string()).to_string(),
            "Validation error: name too long"
        );
    }

    #[test]
    fn domain_errors_are_clone_and_partial_eq() {
        let err = DomainError::CollectionNotFound;
        assert_eq!(err.clone(), DomainError::CollectionNotFound);
    }
}
