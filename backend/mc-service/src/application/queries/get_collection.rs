use std::sync::Arc;

use crate::application::dtos::collection_dto::CollectionDto;
use crate::application::ports::collection_repository::CollectionRepository;
use crate::domain::errors::DomainError;

pub struct GetCollectionQuery {
    pub collection_id: String,
    pub owner_id: String,
}

pub struct GetCollectionHandler {
    pub repository: Arc<dyn CollectionRepository>,
}

impl GetCollectionHandler {
    pub fn new(repository: Arc<dyn CollectionRepository>) -> Self {
        Self { repository }
    }

    pub async fn handle(&self, query: GetCollectionQuery) -> Result<CollectionDto, DomainError> {
        self.repository
            .get_by_id(&query.collection_id, &query.owner_id)
            .await
    }
}

// ─── Unit tests (T158) ───────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::dtos::collection_dto::{
        CollectionDto, CollectionSummaryDto, CreateCollectionDto, UpdateCollectionDto,
    };
    use mockall::mock;

    mock! {
        CollectionRepo {}
        #[async_trait::async_trait]
        impl CollectionRepository for CollectionRepo {
            async fn create(
                &self,
                owner_id: &str,
                dto: CreateCollectionDto,
            ) -> Result<CollectionDto, DomainError>;

            async fn get_by_id(
                &self,
                id: &str,
                owner_id: &str,
            ) -> Result<CollectionDto, DomainError>;

            async fn list_by_owner(
                &self,
                owner_id: &str,
            ) -> Result<Vec<CollectionSummaryDto>, DomainError>;

            async fn update(
                &self,
                id: &str,
                owner_id: &str,
                dto: UpdateCollectionDto,
            ) -> Result<CollectionDto, DomainError>;

            async fn delete(&self, id: &str, owner_id: &str) -> Result<(), DomainError>;

            async fn find_default_for_owner(
                &self,
                owner_id: &str,
            ) -> Result<Option<CollectionDto>, DomainError>;

            async fn clear_default_for_owner(&self, owner_id: &str) -> Result<(), DomainError>;

            async fn set_as_default(
                &self,
                id: &str,
                owner_id: &str,
            ) -> Result<CollectionDto, DomainError>;
        }
    }

    fn make_query() -> GetCollectionQuery {
        GetCollectionQuery {
            collection_id: "coll-123".to_string(),
            owner_id: "owner-456".to_string(),
        }
    }

    fn make_dto() -> CollectionDto {
        CollectionDto {
            id: "coll-123".to_string(),
            owner_id: "owner-456".to_string(),
            name: "My Movies".to_string(),
            description: None,
            is_default: false,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn get_collection_success_returns_dto() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_get_by_id()
            .times(1)
            .returning(|_, _| Ok(make_dto()));

        let handler = GetCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_query()).await;
        assert!(result.is_ok(), "get_by_id should return Ok on success");
        let dto = result.unwrap();
        assert_eq!(dto.id, "coll-123");
        assert_eq!(dto.name, "My Movies");
    }

    #[tokio::test]
    async fn get_collection_forwards_correct_ids() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_get_by_id()
            .withf(|id, owner_id| id == "coll-123" && owner_id == "owner-456")
            .times(1)
            .returning(|_, _| Ok(make_dto()));

        let handler = GetCollectionHandler::new(Arc::new(repo));
        let _ = handler.handle(make_query()).await;
    }

    #[tokio::test]
    async fn get_collection_propagates_not_found() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_get_by_id()
            .times(1)
            .returning(|_, _| Err(DomainError::CollectionNotFound));

        let handler = GetCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_query()).await;
        assert!(
            matches!(result, Err(DomainError::CollectionNotFound)),
            "CollectionNotFound must propagate from repository"
        );
    }

    #[tokio::test]
    async fn get_collection_propagates_access_denied() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_get_by_id()
            .times(1)
            .returning(|_, _| Err(DomainError::AccessDenied));

        let handler = GetCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_query()).await;
        assert!(
            matches!(result, Err(DomainError::AccessDenied)),
            "AccessDenied must propagate from repository"
        );
    }
}
