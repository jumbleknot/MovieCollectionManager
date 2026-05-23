use std::sync::Arc;

use crate::application::dtos::collection_dto::CollectionDto;
use crate::application::ports::collection_repository::CollectionRepository;
use crate::domain::errors::DomainError;

pub struct SetDefaultCollectionCommand {
    pub collection_id: String,
    pub owner_id: String,
}

pub struct SetDefaultCollectionHandler {
    pub repository: Arc<dyn CollectionRepository>,
}

impl SetDefaultCollectionHandler {
    pub fn new(repository: Arc<dyn CollectionRepository>) -> Self {
        Self { repository }
    }

    /// Atomically clears the previous default and sets the target collection as default.
    pub async fn handle(
        &self,
        cmd: SetDefaultCollectionCommand,
    ) -> Result<CollectionDto, DomainError> {
        // Clear the current default first (MongoDB adapter uses a session transaction)
        self.repository
            .clear_default_for_owner(&cmd.owner_id)
            .await?;
        self.repository
            .set_as_default(&cmd.collection_id, &cmd.owner_id)
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

    fn make_cmd() -> SetDefaultCollectionCommand {
        SetDefaultCollectionCommand {
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
            is_default: true,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-02T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn set_default_clears_then_sets() {
        let mut repo = MockCollectionRepo::new();
        let call_order = std::sync::Arc::new(std::sync::Mutex::new(Vec::<&str>::new()));
        let order_clear = call_order.clone();
        let order_set = call_order.clone();

        repo.expect_clear_default_for_owner()
            .withf(|oid| oid == "owner-456")
            .times(1)
            .returning(move |_| {
                order_clear.lock().unwrap().push("clear");
                Ok(())
            });

        repo.expect_set_as_default()
            .withf(|id, oid| id == "coll-123" && oid == "owner-456")
            .times(1)
            .returning(move |_, _| {
                order_set.lock().unwrap().push("set");
                Ok(make_dto())
            });

        let handler = SetDefaultCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd()).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().is_default, true);
        let calls = call_order.lock().unwrap();
        assert_eq!(*calls, vec!["clear", "set"]);
    }

    #[tokio::test]
    async fn set_default_propagates_clear_error() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_clear_default_for_owner()
            .times(1)
            .returning(|_| Err(DomainError::Internal("db error".to_string())));
        repo.expect_set_as_default().times(0); // must not be called

        let handler = SetDefaultCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd()).await;
        assert!(matches!(result, Err(DomainError::Internal(_))));
    }

    #[tokio::test]
    async fn set_default_propagates_set_error() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_clear_default_for_owner()
            .times(1)
            .returning(|_| Ok(()));
        repo.expect_set_as_default()
            .times(1)
            .returning(|_, _| Err(DomainError::CollectionNotFound));

        let handler = SetDefaultCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd()).await;
        assert!(matches!(result, Err(DomainError::CollectionNotFound)));
    }
}
