use std::sync::Arc;

use crate::application::dtos::collection_dto::{CollectionDto, CreateCollectionDto};
use crate::application::ports::collection_repository::CollectionRepository;
use crate::domain::errors::DomainError;
use crate::domain::specifications::collection_name::CollectionNameLengthSpec;
use crate::domain::specifications::spec::Specification;

pub struct CreateCollectionCommand {
    pub owner_id: String,
    pub dto: CreateCollectionDto,
}

pub struct CreateCollectionHandler {
    pub repository: Arc<dyn CollectionRepository>,
}

impl CreateCollectionHandler {
    pub fn new(repository: Arc<dyn CollectionRepository>) -> Self {
        Self { repository }
    }

    pub async fn handle(&self, cmd: CreateCollectionCommand) -> Result<CollectionDto, DomainError> {
        // Validate name via specification
        let name_spec = CollectionNameLengthSpec;
        if !name_spec.is_satisfied_by(&cmd.dto.name) {
            return Err(DomainError::ValidationError(
                "Collection name must be between 1 and 50 characters".to_string(),
            ));
        }

        self.repository.create(&cmd.owner_id, cmd.dto).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockall::mock;
    use mockall::predicate::*;

    mock! {
        CollRepo {}
        #[async_trait::async_trait]
        impl CollectionRepository for CollRepo {
            async fn create(&self, owner_id: &str, dto: CreateCollectionDto) -> Result<CollectionDto, DomainError>;
            async fn get_by_id(&self, id: &str, owner_id: &str) -> Result<CollectionDto, DomainError>;
            async fn find_by_id(&self, id: &str) -> Result<crate::domain::collection::MovieCollection, DomainError>;
            async fn list_by_owner(&self, owner_id: &str) -> Result<Vec<crate::application::dtos::collection_dto::CollectionSummaryDto>, DomainError>;
            async fn update(&self, id: &str, owner_id: &str, dto: crate::application::dtos::collection_dto::UpdateCollectionDto) -> Result<CollectionDto, DomainError>;
            async fn delete(&self, id: &str, owner_id: &str) -> Result<(), DomainError>;
            async fn find_default_for_owner(&self, owner_id: &str) -> Result<Option<CollectionDto>, DomainError>;
            async fn clear_default_for_owner(&self, owner_id: &str) -> Result<(), DomainError>;
            async fn set_as_default(&self, id: &str, owner_id: &str) -> Result<CollectionDto, DomainError>;
        }
    }

    fn make_dto(name: &str) -> CollectionDto {
        CollectionDto {
            id: "abc".to_string(),
            owner_id: "user-1".to_string(),
            name: name.to_string(),
            description: None,
            is_default: false,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    // T027

    #[tokio::test]
    async fn valid_creation_returns_collection_dto() {
        let mut mock_repo = MockCollRepo::new();
        mock_repo
            .expect_create()
            .returning(|_, dto| Ok(make_dto(&dto.name)));

        let handler = CreateCollectionHandler::new(Arc::new(mock_repo));
        let cmd = CreateCollectionCommand {
            owner_id: "user-1".to_string(),
            dto: CreateCollectionDto {
                name: "My Movies".to_string(),
                description: None,
            },
        };

        let result = handler.handle(cmd).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().name, "My Movies");
    }

    #[tokio::test]
    async fn name_too_long_returns_validation_error() {
        let mock_repo = MockCollRepo::new(); // create() should never be called
        let handler = CreateCollectionHandler::new(Arc::new(mock_repo));
        let cmd = CreateCollectionCommand {
            owner_id: "user-1".to_string(),
            dto: CreateCollectionDto {
                name: "a".repeat(51),
                description: None,
            },
        };

        let result = handler.handle(cmd).await;
        assert!(matches!(result, Err(DomainError::ValidationError(_))));
    }

    #[tokio::test]
    async fn duplicate_name_returns_duplicate_error() {
        let mut mock_repo = MockCollRepo::new();
        mock_repo
            .expect_create()
            .returning(|_, _| Err(DomainError::DuplicateCollectionName));

        let handler = CreateCollectionHandler::new(Arc::new(mock_repo));
        let cmd = CreateCollectionCommand {
            owner_id: "user-1".to_string(),
            dto: CreateCollectionDto {
                name: "Existing".to_string(),
                description: None,
            },
        };

        let result = handler.handle(cmd).await;
        assert!(matches!(result, Err(DomainError::DuplicateCollectionName)));
    }
}
