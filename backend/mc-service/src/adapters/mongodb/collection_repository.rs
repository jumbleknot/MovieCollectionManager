use async_trait::async_trait;
use bson::{doc, oid::ObjectId, DateTime};
use mongodb::{Client, Collection, Database};

use crate::adapters::mongodb::daos::collection_dao::CollectionDao;
use crate::application::dtos::collection_dto::{
    CollectionDto, CollectionSummaryDto, CreateCollectionDto, UpdateCollectionDto,
};
use crate::application::ports::collection_repository::CollectionRepository;
use crate::domain::errors::DomainError;

pub struct MongoCollectionRepository {
    /// Retained to start sessions for multi-document transactions.
    client: Client,
    collection: Collection<CollectionDao>,
    movies: Collection<bson::Document>,
}

impl MongoCollectionRepository {
    pub fn new(db: &Database) -> Self {
        Self {
            client: db.client().clone(),
            collection: db.collection("movie_collections"),
            movies: db.collection("movies"),
        }
    }
}

fn dao_to_dto(dao: CollectionDao, _movie_count: u64) -> CollectionDto {
    let id = dao.id.map(|id| id.to_hex()).unwrap_or_default();
    let created_at = dao.created_at.to_string();
    let updated_at = dao.updated_at.to_string();
    CollectionDto {
        id,
        owner_id: dao.owner_id,
        name: dao.name,
        description: dao.description,
        is_default: dao.is_default,
        created_at,
        updated_at,
    }
}

fn is_duplicate_key(err: &mongodb::error::Error) -> bool {
    matches!(err.kind.as_ref(), mongodb::error::ErrorKind::Write(
        mongodb::error::WriteFailure::WriteError(we)
    ) if we.code == 11000)
}

fn parse_object_id(id: &str) -> Result<ObjectId, DomainError> {
    ObjectId::parse_str(id).map_err(|_| DomainError::CollectionNotFound)
}

#[async_trait]
impl CollectionRepository for MongoCollectionRepository {
    async fn create(
        &self,
        owner_id: &str,
        dto: CreateCollectionDto,
    ) -> Result<CollectionDto, DomainError> {
        let now = DateTime::now();
        let dao = CollectionDao {
            id: None,
            owner_id: owner_id.to_string(),
            name: dto.name.clone(),
            description: dto.description.clone(),
            is_default: false,
            acl: vec![
                crate::adapters::mongodb::daos::collection_dao::AclEntryDao {
                    user_id: owner_id.to_string(),
                    role: "owner".to_string(),
                },
            ],
            created_at: now,
            updated_at: now,
        };

        let result = self.collection.insert_one(dao).await.map_err(|e| {
            if is_duplicate_key(&e) {
                DomainError::DuplicateCollectionName
            } else {
                DomainError::Internal(e.to_string())
            }
        })?;

        let id = result
            .inserted_id
            .as_object_id()
            .map(|id| id.to_hex())
            .unwrap_or_default();

        Ok(CollectionDto {
            id,
            owner_id: owner_id.to_string(),
            name: dto.name,
            description: dto.description,
            is_default: false,
            created_at: now.to_string(),
            updated_at: now.to_string(),
        })
    }

    async fn get_by_id(&self, id: &str, owner_id: &str) -> Result<CollectionDto, DomainError> {
        let oid = parse_object_id(id)?;
        let filter = doc! { "_id": oid, "ownerId": owner_id };
        let dao = self
            .collection
            .find_one(filter)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
            .ok_or(DomainError::CollectionNotFound)?;

        let movie_count = self
            .movies
            .count_documents(doc! { "collectionId": oid })
            .await
            .unwrap_or(0);

        Ok(dao_to_dto(dao, movie_count))
    }

    async fn list_by_owner(
        &self,
        owner_id: &str,
    ) -> Result<Vec<CollectionSummaryDto>, DomainError> {
        use futures::TryStreamExt;

        let filter = doc! { "ownerId": owner_id };
        let mut cursor = self
            .collection
            .find(filter)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?;

        let mut results = Vec::new();
        while let Some(dao) = cursor
            .try_next()
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
        {
            let id = dao.id.as_ref().map(|id| id.to_hex()).unwrap_or_default();
            let oid = dao.id.unwrap_or_default();
            let movie_count = self
                .movies
                .count_documents(doc! { "collectionId": oid })
                .await
                .unwrap_or(0);

            results.push(CollectionSummaryDto {
                id,
                name: dao.name,
                description: dao.description,
                is_default: dao.is_default,
                movie_count,
                created_at: dao.created_at.to_string(),
                updated_at: dao.updated_at.to_string(),
            });
        }
        Ok(results)
    }

    async fn update(
        &self,
        id: &str,
        owner_id: &str,
        dto: UpdateCollectionDto,
    ) -> Result<CollectionDto, DomainError> {
        let oid = parse_object_id(id)?;
        let filter = doc! { "_id": oid, "ownerId": owner_id };

        let mut set_doc = doc! { "updatedAt": DateTime::now() };
        if let Some(name) = dto.name {
            set_doc.insert("name", name);
        }
        if let Some(desc) = dto.description {
            set_doc.insert("description", desc);
        }
        if let Some(is_default) = dto.is_default {
            set_doc.insert("isDefault", is_default);
        }

        let update = doc! { "$set": set_doc };
        let result = self
            .collection
            .update_one(filter.clone(), update)
            .await
            .map_err(|e| {
                if is_duplicate_key(&e) {
                    DomainError::DuplicateCollectionName
                } else {
                    DomainError::Internal(e.to_string())
                }
            })?;

        if result.matched_count == 0 {
            return Err(DomainError::CollectionNotFound);
        }

        self.get_by_id(id, owner_id).await
    }

    async fn delete(&self, id: &str, owner_id: &str) -> Result<(), DomainError> {
        let oid = parse_object_id(id)?;

        // Use a multi-document transaction so that collection removal and the
        // movie cascade are atomic.  If the process crashes after deleting the
        // collection document but before deleting movies, the transaction is
        // automatically rolled back by MongoDB on the next session recovery,
        // leaving the data in a consistent state.
        let mut session = self
            .client
            .start_session()
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?;
        session
            .start_transaction()
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?;

        // Verify ownership FIRST: only the owner may delete the collection.
        // Using ownerId in the filter ensures we never cascade-delete another
        // user's movies before confirming the caller has the right to delete.
        let filter = doc! { "_id": oid, "ownerId": owner_id };
        let result = self
            .collection
            .delete_one(filter)
            .session(&mut session)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?;

        if result.deleted_count == 0 {
            // Ownership check failed — abort cleanly; no movies were touched.
            session.abort_transaction().await.ok();
            return Err(DomainError::CollectionNotFound);
        }

        // Ownership confirmed — cascade-delete all movies in the collection.
        self.movies
            .delete_many(doc! { "collectionId": oid })
            .session(&mut session)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?;

        session
            .commit_transaction()
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?;

        Ok(())
    }

    async fn find_default_for_owner(
        &self,
        owner_id: &str,
    ) -> Result<Option<CollectionDto>, DomainError> {
        let filter = doc! { "ownerId": owner_id, "isDefault": true };
        let dao = self
            .collection
            .find_one(filter)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?;

        Ok(dao.map(|d| dao_to_dto(d, 0)))
    }

    async fn clear_default_for_owner(&self, owner_id: &str) -> Result<(), DomainError> {
        let filter = doc! { "ownerId": owner_id, "isDefault": true };
        let update = doc! { "$set": { "isDefault": false, "updatedAt": DateTime::now() } };
        self.collection
            .update_many(filter, update)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?;
        Ok(())
    }

    async fn set_as_default(&self, id: &str, owner_id: &str) -> Result<CollectionDto, DomainError> {
        let oid = parse_object_id(id)?;
        let filter = doc! { "_id": oid, "ownerId": owner_id };
        let update = doc! { "$set": { "isDefault": true, "updatedAt": DateTime::now() } };

        let result = self
            .collection
            .update_one(filter, update)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?;

        if result.matched_count == 0 {
            return Err(DomainError::CollectionNotFound);
        }

        self.get_by_id(id, owner_id).await
    }
}
