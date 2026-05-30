use std::sync::Arc;

use crate::application::ports::movie_repository::MovieRepository;
use crate::domain::errors::DomainError;

pub struct DeleteMovieCommand {
    pub collection_id: String,
    pub movie_id: String,
    pub owner_id: String,
}

pub struct DeleteMovieHandler {
    pub repository: Arc<dyn MovieRepository>,
}

impl DeleteMovieHandler {
    pub fn new(repository: Arc<dyn MovieRepository>) -> Self {
        Self { repository }
    }

    pub async fn handle(&self, cmd: DeleteMovieCommand) -> Result<(), DomainError> {
        self.repository
            .delete(&cmd.collection_id, &cmd.movie_id, &cmd.owner_id)
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

            async fn get_filter_options(
                &self,
                collection_id: &str,
                owner_id: &str,
            ) -> Result<FilterOptionsDto, DomainError>;
        }
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

        let handler = DeleteMovieHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd()).await;
        assert!(result.is_ok(), "delete should return Ok on success");
    }

    #[tokio::test]
    async fn delete_forwards_collection_not_found() {
        let mut repo = MockMovieRepo::new();
        repo.expect_delete()
            .times(1)
            .returning(|_, _, _| Err(DomainError::CollectionNotFound));

        let handler = DeleteMovieHandler::new(Arc::new(repo));
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

        let handler = DeleteMovieHandler::new(Arc::new(repo));
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

        let handler = DeleteMovieHandler::new(Arc::new(repo));
        let _ = handler.handle(make_cmd()).await;
    }
}
