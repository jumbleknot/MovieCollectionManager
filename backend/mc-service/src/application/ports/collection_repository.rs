use async_trait::async_trait;

use crate::application::dtos::collection_dto::{
    CollectionDto, CollectionSummaryDto, CreateCollectionDto, UpdateCollectionDto,
};
use crate::domain::collection::MovieCollection;
use crate::domain::errors::DomainError;

/// Repository interface (port) for movie collection persistence.
/// Implemented by the MongoDB adapter in the Adapters layer.
#[async_trait]
pub trait CollectionRepository: Send + Sync {
    async fn create(
        &self,
        owner_id: &str,
        dto: CreateCollectionDto,
    ) -> Result<CollectionDto, DomainError>;

    async fn get_by_id(&self, id: &str, owner_id: &str) -> Result<CollectionDto, DomainError>;

    /// Load a collection by id alone (NOT owner-scoped), returning the domain
    /// aggregate including its ACL — used to authorize movie operations against
    /// the collection's access list. `CollectionNotFound` if absent.
    async fn find_by_id(&self, id: &str) -> Result<MovieCollection, DomainError>;

    async fn list_by_owner(&self, owner_id: &str)
        -> Result<Vec<CollectionSummaryDto>, DomainError>;

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

    async fn set_as_default(&self, id: &str, owner_id: &str) -> Result<CollectionDto, DomainError>;
}
