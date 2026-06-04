use std::sync::Arc;

use crate::application::ports::collection_repository::CollectionRepository;
use crate::domain::errors::DomainError;

pub struct DeleteCollectionCommand {
    pub collection_id: String,
    pub owner_id: String,
}

pub struct DeleteCollectionHandler {
    pub repository: Arc<dyn CollectionRepository>,
}

impl DeleteCollectionHandler {
    pub fn new(repository: Arc<dyn CollectionRepository>) -> Self {
        Self { repository }
    }

    pub async fn handle(&self, cmd: DeleteCollectionCommand) -> Result<(), DomainError> {
        self.repository
            .delete(&cmd.collection_id, &cmd.owner_id)
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

    fn make_cmd() -> DeleteCollectionCommand {
        DeleteCollectionCommand {
            collection_id: "coll-123".to_string(),
            owner_id: "owner-456".to_string(),
        }
    }

    #[tokio::test]
    async fn delete_collection_success_returns_ok() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_delete()
            .withf(|id, oid| id == "coll-123" && oid == "owner-456")
            .times(1)
            .returning(|_, _| Ok(()));

        let handler = DeleteCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd()).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn delete_collection_propagates_not_found() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_delete()
            .times(1)
            .returning(|_, _| Err(DomainError::CollectionNotFound));

        let handler = DeleteCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd()).await;
        assert!(matches!(result, Err(DomainError::CollectionNotFound)));
    }

    #[tokio::test]
    async fn delete_collection_propagates_access_denied() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_delete()
            .times(1)
            .returning(|_, _| Err(DomainError::AccessDenied));

        let handler = DeleteCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd()).await;
        assert!(matches!(result, Err(DomainError::AccessDenied)));
    }
}
