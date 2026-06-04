//! Resource-level access control for movie operations (011 DAC, FR-001/003/008).
//!
//! A single shared helper every movie handler calls before reading or writing,
//! so per-collection authorization is uniform and hard to omit. Authorization is
//! deny-by-default and reports an unauthorized caller as `CollectionNotFound` (404)
//! to avoid leaking whether the collection exists.

use crate::application::ports::collection_repository::CollectionRepository;
use crate::domain::collection::{AclRole, MovieCollection};
use crate::domain::errors::DomainError;

/// Load the parent collection and authorize `caller_id` for `required` access.
///
/// Returns the collection aggregate on success (callers reuse it, e.g. to stamp
/// `movie.ownerId` with the collection owner). A missing collection OR an
/// unauthorized caller both yield `CollectionNotFound` — indistinguishable, by
/// design (no existence leak).
pub async fn authorize_collection_access(
    collection_repo: &dyn CollectionRepository,
    collection_id: &str,
    caller_id: &str,
    required: AclRole,
) -> Result<MovieCollection, DomainError> {
    let collection = collection_repo.find_by_id(collection_id).await?;
    if collection.authorizes(caller_id, required) {
        Ok(collection)
    } else {
        Err(DomainError::CollectionNotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::dtos::collection_dto::{
        CollectionDto, CollectionSummaryDto, CreateCollectionDto, UpdateCollectionDto,
    };
    use crate::domain::collection::{AclEntry, MovieCollection};
    use mockall::mock;
    use std::sync::Arc;

    mock! {
        CollRepo {}
        #[async_trait::async_trait]
        impl CollectionRepository for CollRepo {
            async fn create(&self, owner_id: &str, dto: CreateCollectionDto) -> Result<CollectionDto, DomainError>;
            async fn get_by_id(&self, id: &str, owner_id: &str) -> Result<CollectionDto, DomainError>;
            async fn find_by_id(&self, id: &str) -> Result<MovieCollection, DomainError>;
            async fn list_by_owner(&self, owner_id: &str) -> Result<Vec<CollectionSummaryDto>, DomainError>;
            async fn update(&self, id: &str, owner_id: &str, dto: UpdateCollectionDto) -> Result<CollectionDto, DomainError>;
            async fn delete(&self, id: &str, owner_id: &str) -> Result<(), DomainError>;
            async fn find_default_for_owner(&self, owner_id: &str) -> Result<Option<CollectionDto>, DomainError>;
            async fn clear_default_for_owner(&self, owner_id: &str) -> Result<(), DomainError>;
            async fn set_as_default(&self, id: &str, owner_id: &str) -> Result<CollectionDto, DomainError>;
        }
    }

    fn collection_owned_by(owner: &str) -> MovieCollection {
        MovieCollection::new(owner, "C", None)
    }

    #[tokio::test]
    async fn authorized_owner_returns_the_collection() {
        let mut repo = MockCollRepo::new();
        repo.expect_find_by_id()
            .returning(|_| Ok(collection_owned_by("owner-1")));
        let repo: Arc<dyn CollectionRepository> = Arc::new(repo);

        let result =
            authorize_collection_access(repo.as_ref(), "c1", "owner-1", AclRole::Contributor).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().owner_id, "owner-1");
    }

    #[tokio::test]
    async fn unauthorized_caller_returns_collection_not_found() {
        let mut repo = MockCollRepo::new();
        // Collection owned by someone else; caller has no ACL entry.
        repo.expect_find_by_id()
            .returning(|_| Ok(collection_owned_by("owner-1")));
        let repo: Arc<dyn CollectionRepository> = Arc::new(repo);

        let result =
            authorize_collection_access(repo.as_ref(), "c1", "intruder", AclRole::Viewer).await;
        assert!(matches!(result, Err(DomainError::CollectionNotFound)));
    }

    #[tokio::test]
    async fn viewer_denied_contributor_access_returns_not_found() {
        let mut repo = MockCollRepo::new();
        repo.expect_find_by_id().returning(|_| {
            let mut c = collection_owned_by("owner-1");
            c.acl.push(AclEntry {
                user_id: "viewer-2".to_string(),
                role: AclRole::Viewer,
            });
            Ok(c)
        });
        let repo: Arc<dyn CollectionRepository> = Arc::new(repo);

        let result =
            authorize_collection_access(repo.as_ref(), "c1", "viewer-2", AclRole::Contributor)
                .await;
        assert!(matches!(result, Err(DomainError::CollectionNotFound)));
    }

    #[tokio::test]
    async fn missing_collection_propagates_not_found() {
        let mut repo = MockCollRepo::new();
        repo.expect_find_by_id()
            .returning(|_| Err(DomainError::CollectionNotFound));
        let repo: Arc<dyn CollectionRepository> = Arc::new(repo);

        let result =
            authorize_collection_access(repo.as_ref(), "missing", "anyone", AclRole::Viewer).await;
        assert!(matches!(result, Err(DomainError::CollectionNotFound)));
    }
}
