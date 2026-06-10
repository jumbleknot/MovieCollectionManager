use std::sync::Arc;

use crate::application::access_control::authorize_collection_access;
use crate::application::ports::collection_repository::CollectionRepository;
use crate::application::ports::movie_repository::{ListMoviesParams, MovieRepository};
use crate::domain::collection::AclRole;
use crate::domain::errors::DomainError;

/// Count the movies in a collection matching `params` (the same structural filter as
/// `ListMoviesQuery`; the `cursor` field is ignored). Read-only, DAC-gated at Viewer (US4).
pub struct CountMoviesQuery {
    pub collection_id: String,
    pub owner_id: String,
    pub params: ListMoviesParams,
}

pub struct CountMoviesHandler {
    pub repository: Arc<dyn MovieRepository>,
    pub collection_repository: Arc<dyn CollectionRepository>,
}

impl CountMoviesHandler {
    pub fn new(
        repository: Arc<dyn MovieRepository>,
        collection_repository: Arc<dyn CollectionRepository>,
    ) -> Self {
        Self {
            repository,
            collection_repository,
        }
    }

    pub async fn handle(&self, query: CountMoviesQuery) -> Result<u64, DomainError> {
        // DAC: caller must have viewer access on the collection (011 FR-003/004/008) — denied
        // collections 404 exactly like list/get (no information leak).
        let collection = authorize_collection_access(
            self.collection_repository.as_ref(),
            &query.collection_id,
            &query.owner_id,
            AclRole::Viewer,
        )
        .await?;

        self.repository
            .count(&query.collection_id, &collection.owner_id, query.params)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockall::mock;
    use mockall::predicate::*;

    use crate::application::dtos::movie_dto::{
        CreateMovieDto, FilterOptionsDto, MovieDto, MovieListDto, UpdateMovieDto,
    };

    mock! {
        MovieRepo {}
        #[async_trait::async_trait]
        impl MovieRepository for MovieRepo {
            async fn create(&self, collection_id: &str, owner_id: &str, dto: CreateMovieDto) -> Result<MovieDto, DomainError>;
            async fn get_by_id(&self, collection_id: &str, movie_id: &str, owner_id: &str) -> Result<MovieDto, DomainError>;
            async fn update(&self, collection_id: &str, movie_id: &str, owner_id: &str, dto: UpdateMovieDto) -> Result<MovieDto, DomainError>;
            async fn delete(&self, collection_id: &str, movie_id: &str, owner_id: &str) -> Result<(), DomainError>;
            async fn list(&self, collection_id: &str, owner_id: &str, params: ListMoviesParams) -> Result<MovieListDto, DomainError>;
            async fn count(&self, collection_id: &str, owner_id: &str, params: ListMoviesParams) -> Result<u64, DomainError>;
            async fn get_filter_options(&self, collection_id: &str, owner_id: &str) -> Result<FilterOptionsDto, DomainError>;
        }
    }

    use crate::application::dtos::collection_dto::{
        CollectionDto, CollectionSummaryDto, CreateCollectionDto, UpdateCollectionDto,
    };
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

    fn make_handler(repo: MockMovieRepo, owner: &'static str) -> CountMoviesHandler {
        let mut coll = MockCollRepo::new();
        coll.expect_find_by_id()
            .returning(move |_| Ok(MovieCollection::new(owner, "C", None)));
        CountMoviesHandler::new(Arc::new(repo), Arc::new(coll))
    }

    #[tokio::test]
    async fn count_forwards_collection_owner_and_filter_to_repository() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo
            .expect_count()
            .withf(|coll_id, owner_id, params| {
                coll_id == "coll-1" && owner_id == "user-1" && params.genres == vec!["Action".to_string()]
            })
            .returning(|_, _, _| Ok(7));

        let handler = make_handler(mock_repo, "user-1");
        let query = CountMoviesQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
            params: ListMoviesParams {
                genres: vec!["Action".to_string()],
                // cursor is ignored by count — present here to prove it is not forwarded as a filter.
                cursor: Some("ignored".to_string()),
                ..Default::default()
            },
        };

        assert_eq!(handler.handle(query).await.unwrap(), 7);
    }

    #[tokio::test]
    async fn zero_count_returned() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo.expect_count().returning(|_, _, _| Ok(0));
        let handler = make_handler(mock_repo, "user-1");
        let query = CountMoviesQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
            params: ListMoviesParams::default(),
        };
        assert_eq!(handler.handle(query).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn repository_error_propagates() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo
            .expect_count()
            .returning(|_, _, _| Err(DomainError::CollectionNotFound));
        let handler = make_handler(mock_repo, "user-1");
        let query = CountMoviesQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
            params: ListMoviesParams::default(),
        };
        assert!(matches!(
            handler.handle(query).await,
            Err(DomainError::CollectionNotFound)
        ));
    }
}
