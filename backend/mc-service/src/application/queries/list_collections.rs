use std::sync::Arc;

use crate::application::dtos::collection_dto::CollectionSummaryDto;
use crate::application::ports::collection_repository::CollectionRepository;
use crate::domain::errors::DomainError;

pub struct ListCollectionsQuery {
    pub owner_id: String,
}

pub struct ListCollectionsHandler {
    pub repository: Arc<dyn CollectionRepository>,
}

impl ListCollectionsHandler {
    pub fn new(repository: Arc<dyn CollectionRepository>) -> Self {
        Self { repository }
    }

    pub async fn handle(
        &self,
        query: ListCollectionsQuery,
    ) -> Result<Vec<CollectionSummaryDto>, DomainError> {
        self.repository.list_by_owner(&query.owner_id).await
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

            async fn find_by_id(&self, id: &str) -> Result<crate::domain::collection::MovieCollection, DomainError>;

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

    fn make_query() -> ListCollectionsQuery {
        ListCollectionsQuery {
            owner_id: "owner-123".to_string(),
        }
    }

    fn make_summary(id: &str, name: &str) -> CollectionSummaryDto {
        CollectionSummaryDto {
            id: id.to_string(),
            name: name.to_string(),
            description: None,
            is_default: false,
            movie_count: 0,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn list_collections_success_returns_list() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_list_by_owner()
            .times(1)
            .returning(|_| Ok(vec![make_summary("c1", "Movies"), make_summary("c2", "TV")]));

        let handler = ListCollectionsHandler::new(Arc::new(repo));
        let result = handler.handle(make_query()).await;
        assert!(result.is_ok());
        let list = result.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "c1");
        assert_eq!(list[1].name, "TV");
    }

    #[tokio::test]
    async fn list_collections_forwards_owner_id() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_list_by_owner()
            .withf(|oid| oid == "owner-123")
            .times(1)
            .returning(|_| Ok(vec![]));

        let handler = ListCollectionsHandler::new(Arc::new(repo));
        let _ = handler.handle(make_query()).await;
    }

    #[tokio::test]
    async fn list_collections_returns_empty_when_none() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_list_by_owner()
            .times(1)
            .returning(|_| Ok(vec![]));

        let handler = ListCollectionsHandler::new(Arc::new(repo));
        let result = handler.handle(make_query()).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn list_collections_propagates_internal_error() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_list_by_owner()
            .times(1)
            .returning(|_| Err(DomainError::Internal("db error".to_string())));

        let handler = ListCollectionsHandler::new(Arc::new(repo));
        let result = handler.handle(make_query()).await;
        assert!(matches!(result, Err(DomainError::Internal(_))));
    }
}
