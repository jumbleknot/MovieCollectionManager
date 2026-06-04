use std::sync::Arc;

use crate::application::dtos::collection_dto::{CollectionDto, UpdateCollectionDto};
use crate::application::ports::collection_repository::CollectionRepository;
use crate::domain::errors::DomainError;
use crate::domain::specifications::collection_name::CollectionNameLengthSpec;
use crate::domain::specifications::spec::Specification;

pub struct UpdateCollectionCommand {
    pub collection_id: String,
    pub owner_id: String,
    pub dto: UpdateCollectionDto,
}

pub struct UpdateCollectionHandler {
    pub repository: Arc<dyn CollectionRepository>,
}

impl UpdateCollectionHandler {
    pub fn new(repository: Arc<dyn CollectionRepository>) -> Self {
        Self { repository }
    }

    pub async fn handle(&self, cmd: UpdateCollectionCommand) -> Result<CollectionDto, DomainError> {
        // Validate name if provided
        if let Some(ref name) = cmd.dto.name {
            let name_spec = CollectionNameLengthSpec;
            if !name_spec.is_satisfied_by(name) {
                return Err(DomainError::ValidationError(
                    "Collection name must be between 1 and 50 characters".to_string(),
                ));
            }
        }

        self.repository
            .update(&cmd.collection_id, &cmd.owner_id, cmd.dto)
            .await
    }
}

// ─── Unit tests (T158) ───────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::dtos::collection_dto::{
        CollectionDto, CollectionSummaryDto, CreateCollectionDto,
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

    fn make_dto(name: Option<&str>) -> UpdateCollectionDto {
        UpdateCollectionDto {
            name: name.map(str::to_string),
            description: None,
            is_default: None,
        }
    }

    fn make_cmd(dto: UpdateCollectionDto) -> UpdateCollectionCommand {
        UpdateCollectionCommand {
            collection_id: "coll-123".to_string(),
            owner_id: "owner-456".to_string(),
            dto,
        }
    }

    fn make_result_dto() -> CollectionDto {
        CollectionDto {
            id: "coll-123".to_string(),
            owner_id: "owner-456".to_string(),
            name: "Updated Name".to_string(),
            description: None,
            is_default: false,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-02T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn update_collection_success_with_valid_name() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_update()
            .withf(|id, oid, _| id == "coll-123" && oid == "owner-456")
            .times(1)
            .returning(|_, _, _| Ok(make_result_dto()));

        let handler = UpdateCollectionHandler::new(Arc::new(repo));
        let result = handler
            .handle(make_cmd(make_dto(Some("Updated Name"))))
            .await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().name, "Updated Name");
    }

    #[tokio::test]
    async fn update_collection_rejects_empty_name() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_update().times(0);

        let handler = UpdateCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd(make_dto(Some("")))).await;
        assert!(
            matches!(result, Err(DomainError::ValidationError(_))),
            "empty name must be rejected"
        );
    }

    #[tokio::test]
    async fn update_collection_rejects_name_exceeding_50_chars() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_update().times(0);

        let long_name = "A".repeat(51);
        let handler = UpdateCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd(make_dto(Some(&long_name)))).await;
        assert!(matches!(result, Err(DomainError::ValidationError(_))));
    }

    #[tokio::test]
    async fn update_collection_skips_validation_when_name_absent() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_update()
            .times(1)
            .returning(|_, _, _| Ok(make_result_dto()));

        let handler = UpdateCollectionHandler::new(Arc::new(repo));
        // No name provided — only description updated
        let result = handler.handle(make_cmd(make_dto(None))).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn update_collection_propagates_not_found() {
        let mut repo = MockCollectionRepo::new();
        repo.expect_update()
            .times(1)
            .returning(|_, _, _| Err(DomainError::CollectionNotFound));

        let handler = UpdateCollectionHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd(make_dto(Some("Valid")))).await;
        assert!(matches!(result, Err(DomainError::CollectionNotFound)));
    }
}
