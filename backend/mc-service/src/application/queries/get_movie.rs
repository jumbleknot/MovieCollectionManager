use std::sync::Arc;

use crate::application::access_control::authorize_collection_access;
use crate::application::dtos::movie_dto::MovieDto;
use crate::application::ports::collection_repository::CollectionRepository;
use crate::application::ports::movie_repository::MovieRepository;
use crate::domain::collection::AclRole;
use crate::domain::errors::DomainError;

pub struct GetMovieQuery {
    pub collection_id: String,
    pub movie_id: String,
    pub owner_id: String,
}

pub struct GetMovieHandler {
    pub repository: Arc<dyn MovieRepository>,
    pub collection_repository: Arc<dyn CollectionRepository>,
}

impl GetMovieHandler {
    pub fn new(
        repository: Arc<dyn MovieRepository>,
        collection_repository: Arc<dyn CollectionRepository>,
    ) -> Self {
        Self {
            repository,
            collection_repository,
        }
    }

    pub async fn handle(&self, query: GetMovieQuery) -> Result<MovieDto, DomainError> {
        // DAC: caller must have viewer access on the collection (011 FR-003/004/008).
        let collection = authorize_collection_access(
            self.collection_repository.as_ref(),
            &query.collection_id,
            &query.owner_id,
            AclRole::Viewer,
        )
        .await?;

        self.repository
            .get_by_id(&query.collection_id, &query.movie_id, &collection.owner_id)
            .await
    }
}

// ─── Unit tests (T158) ───────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::dtos::movie_dto::{
        CreateMovieDto, FilterOptionsDto, MovieDto, MovieListDto, UpdateMovieDto,
    };
    use crate::application::ports::movie_repository::ListMoviesParams;
    use crate::domain::movie::ContentType;
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

    /// Handler whose collection mock authorizes caller `owner-789` as owner.
    fn make_handler(repo: MockMovieRepo) -> GetMovieHandler {
        let mut coll = MockCollRepo::new();
        coll.expect_find_by_id()
            .returning(|_| Ok(MovieCollection::new("owner-789", "C", None)));
        GetMovieHandler::new(Arc::new(repo), Arc::new(coll))
    }

    fn make_query() -> GetMovieQuery {
        GetMovieQuery {
            collection_id: "coll-123".to_string(),
            movie_id: "movie-456".to_string(),
            owner_id: "owner-789".to_string(),
        }
    }

    fn make_dto() -> MovieDto {
        MovieDto {
            id: "movie-456".to_string(),
            collection_id: "coll-123".to_string(),
            title: "The Matrix".to_string(),
            year: 1999,
            content_type: ContentType::Movie,
            language: Some("en".to_string()),
            owned: true,
            ripped: false,
            childrens: false,
            original_title: None,
            release_date: None,
            outline: None,
            plot: None,
            runtime: None,
            rated: None,
            directors: vec![],
            actors: vec![],
            movie_set: None,
            tags: vec![],
            genres: vec![],
            owned_media: vec![],
            rip_quality: vec![],
            external_ids: vec![],
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn get_movie_success_returns_dto() {
        let mut repo = MockMovieRepo::new();
        repo.expect_get_by_id()
            .times(1)
            .returning(|_, _, _| Ok(make_dto()));

        let handler = make_handler(repo);
        let result = handler.handle(make_query()).await;
        assert!(result.is_ok(), "get_by_id should return Ok on success");
        let dto = result.unwrap();
        assert_eq!(dto.id, "movie-456");
        assert_eq!(dto.title, "The Matrix");
    }

    #[tokio::test]
    async fn get_movie_forwards_correct_ids() {
        let mut repo = MockMovieRepo::new();
        repo.expect_get_by_id()
            .withf(|cid, mid, oid| cid == "coll-123" && mid == "movie-456" && oid == "owner-789")
            .times(1)
            .returning(|_, _, _| Ok(make_dto()));

        let handler = make_handler(repo);
        let _ = handler.handle(make_query()).await;
    }

    #[tokio::test]
    async fn get_movie_propagates_movie_not_found() {
        let mut repo = MockMovieRepo::new();
        repo.expect_get_by_id()
            .times(1)
            .returning(|_, _, _| Err(DomainError::MovieNotFound));

        let handler = make_handler(repo);
        let result = handler.handle(make_query()).await;
        assert!(
            matches!(result, Err(DomainError::MovieNotFound)),
            "MovieNotFound must propagate from repository"
        );
    }

    #[tokio::test]
    async fn get_movie_propagates_collection_not_found() {
        let mut repo = MockMovieRepo::new();
        repo.expect_get_by_id()
            .times(1)
            .returning(|_, _, _| Err(DomainError::CollectionNotFound));

        let handler = make_handler(repo);
        let result = handler.handle(make_query()).await;
        assert!(
            matches!(result, Err(DomainError::CollectionNotFound)),
            "CollectionNotFound must propagate from repository"
        );
    }
}
