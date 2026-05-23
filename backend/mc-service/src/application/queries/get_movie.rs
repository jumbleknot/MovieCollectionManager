use std::sync::Arc;

use crate::application::dtos::movie_dto::MovieDto;
use crate::application::ports::movie_repository::MovieRepository;
use crate::domain::errors::DomainError;

pub struct GetMovieQuery {
    pub collection_id: String,
    pub movie_id: String,
    pub owner_id: String,
}

pub struct GetMovieHandler {
    pub repository: Arc<dyn MovieRepository>,
}

impl GetMovieHandler {
    pub fn new(repository: Arc<dyn MovieRepository>) -> Self {
        Self { repository }
    }

    pub async fn handle(&self, query: GetMovieQuery) -> Result<MovieDto, DomainError> {
        self.repository
            .get_by_id(&query.collection_id, &query.movie_id, &query.owner_id)
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

            async fn get_filter_options(
                &self,
                collection_id: &str,
                owner_id: &str,
            ) -> Result<FilterOptionsDto, DomainError>;
        }
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
            language: "en".to_string(),
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

        let handler = GetMovieHandler::new(Arc::new(repo));
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

        let handler = GetMovieHandler::new(Arc::new(repo));
        let _ = handler.handle(make_query()).await;
    }

    #[tokio::test]
    async fn get_movie_propagates_movie_not_found() {
        let mut repo = MockMovieRepo::new();
        repo.expect_get_by_id()
            .times(1)
            .returning(|_, _, _| Err(DomainError::MovieNotFound));

        let handler = GetMovieHandler::new(Arc::new(repo));
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

        let handler = GetMovieHandler::new(Arc::new(repo));
        let result = handler.handle(make_query()).await;
        assert!(
            matches!(result, Err(DomainError::CollectionNotFound)),
            "CollectionNotFound must propagate from repository"
        );
    }
}
