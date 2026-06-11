use std::sync::Arc;

use crate::application::access_control::authorize_collection_access;
use crate::application::ports::collection_repository::CollectionRepository;
use crate::application::ports::movie_repository::MovieRepository;
use crate::domain::collection::AclRole;
use crate::domain::errors::DomainError;

pub struct DeleteMovieCommand {
    pub collection_id: String,
    pub movie_id: String,
    pub owner_id: String,
}

pub struct DeleteMovieHandler {
    pub repository: Arc<dyn MovieRepository>,
    pub collection_repository: Arc<dyn CollectionRepository>,
}

impl DeleteMovieHandler {
    pub fn new(
        repository: Arc<dyn MovieRepository>,
        collection_repository: Arc<dyn CollectionRepository>,
    ) -> Self {
        Self {
            repository,
            collection_repository,
        }
    }

    pub async fn handle(&self, cmd: DeleteMovieCommand) -> Result<(), DomainError> {
        // DAC: caller must be a contributor on the collection (011 FR-001/002/008).
        let collection = authorize_collection_access(
            self.collection_repository.as_ref(),
            &cmd.collection_id,
            &cmd.owner_id,
            AclRole::Contributor,
        )
        .await?;

        self.repository
            .delete(&cmd.collection_id, &cmd.movie_id, &collection.owner_id)
            .await
    }
}

// ─── Unit tests (T139) ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::dtos::movie_dto::{
        CreateMovieDto, FilterOptionsDto, MovieDto, MovieListDto, UpdateMovieDto,
    };
    use crate::application::ports::movie_repository::ListMoviesParams;
    use mockall::mock;

    mock! {
        MovieRepo {}
        #[async_trait::async_trait]
        impl MovieRepository for MovieRepo {
            async fn create(
                &self,
                collection_id: &str,
                owner_id: &str,
                dto: CreateMovieDto,
            ) -> Result<MovieDto, DomainError>;

            async fn get_by_id(
                &self,
                collection_id: &str,
                movie_id: &str,
                owner_id: &str,
            ) -> Result<MovieDto, DomainError>;

            async fn update(
                &self,
                collection_id: &str,
                movie_id: &str,
                owner_id: &str,
                dto: UpdateMovieDto,
            ) -> Result<MovieDto, DomainError>;

            async fn delete(
                &self,
                collection_id: &str,
                movie_id: &str,
                owner_id: &str,
            ) -> Result<(), DomainError>;

            async fn list(
                &self,
                collection_id: &str,
                owner_id: &str,
                params: ListMoviesParams,
            ) -> Result<MovieListDto, DomainError>;

            async fn count(
                &self,
                collection_id: &str,
                owner_id: &str,
                params: ListMoviesParams,
            ) -> Result<u64, DomainError>;

            async fn get_filter_options(
                &self,
                collection_id: &str,
                owner_id: &str,
            ) -> Result<FilterOptionsDto, DomainError>;
        }
    }

    use crate::application::dtos::collection_dto::{
        CollectionDto, CollectionSummaryDto, CreateCollectionDto, UpdateCollectionDto,
    };
    use crate::application::ports::collection_repository::CollectionRepository;
    use crate::domain::collection::MovieCollection;

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

    /// Handler whose collection mock authorizes the command's caller (`owner-789`)
    /// as owner — so the collection owner used for the delete equals `owner-789`.
    fn make_handler(repo: MockMovieRepo) -> DeleteMovieHandler {
        let mut coll = MockCollRepo::new();
        coll.expect_find_by_id()
            .returning(|_| Ok(MovieCollection::new("owner-789", "C", None)));
        DeleteMovieHandler::new(Arc::new(repo), Arc::new(coll))
    }

    fn make_cmd() -> DeleteMovieCommand {
        DeleteMovieCommand {
            collection_id: "coll-123".to_string(),
            movie_id: "movie-456".to_string(),
            owner_id: "owner-789".to_string(),
        }
    }

    #[tokio::test]
    async fn delete_success_returns_ok() {
        let mut repo = MockMovieRepo::new();
        repo.expect_delete()
            .withf(|cid, mid, oid| cid == "coll-123" && mid == "movie-456" && oid == "owner-789")
            .times(1)
            .returning(|_, _, _| Ok(()));

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd()).await;
        assert!(result.is_ok(), "delete should return Ok on success");
    }

    #[tokio::test]
    async fn delete_forwards_collection_not_found() {
        let mut repo = MockMovieRepo::new();
        repo.expect_delete()
            .times(1)
            .returning(|_, _, _| Err(DomainError::CollectionNotFound));

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd()).await;
        assert!(
            matches!(result, Err(DomainError::CollectionNotFound)),
            "CollectionNotFound must propagate from repository"
        );
    }

    #[tokio::test]
    async fn delete_forwards_movie_not_found() {
        let mut repo = MockMovieRepo::new();
        repo.expect_delete()
            .times(1)
            .returning(|_, _, _| Err(DomainError::MovieNotFound));

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd()).await;
        assert!(
            matches!(result, Err(DomainError::MovieNotFound)),
            "MovieNotFound must propagate from repository"
        );
    }

    #[tokio::test]
    async fn delete_forwards_ids_to_repository() {
        let mut repo = MockMovieRepo::new();
        // Verify correct IDs are forwarded
        repo.expect_delete()
            .withf(|cid, mid, oid| cid == "coll-123" && mid == "movie-456" && oid == "owner-789")
            .times(1)
            .returning(|_, _, _| Ok(()));

        let handler = make_handler(repo);
        let _ = handler.handle(make_cmd()).await;
    }
}
