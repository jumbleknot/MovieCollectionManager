use std::sync::Arc;

use crate::application::access_control::authorize_collection_access;
use crate::application::dtos::movie_dto::FilterOptionsDto;
use crate::application::ports::collection_repository::CollectionRepository;
use crate::application::ports::movie_repository::MovieRepository;
use crate::domain::collection::AclRole;
use crate::domain::errors::DomainError;

pub struct GetFilterOptionsQuery {
    pub collection_id: String,
    pub owner_id: String,
}

pub struct GetFilterOptionsHandler {
    pub repository: Arc<dyn MovieRepository>,
    pub collection_repository: Arc<dyn CollectionRepository>,
}

impl GetFilterOptionsHandler {
    pub fn new(
        repository: Arc<dyn MovieRepository>,
        collection_repository: Arc<dyn CollectionRepository>,
    ) -> Self {
        Self {
            repository,
            collection_repository,
        }
    }

    pub async fn handle(
        &self,
        query: GetFilterOptionsQuery,
    ) -> Result<FilterOptionsDto, DomainError> {
        // DAC: caller must have viewer access on the collection (011 FR-003/004/008).
        let collection = authorize_collection_access(
            self.collection_repository.as_ref(),
            &query.collection_id,
            &query.owner_id,
            AclRole::Viewer,
        )
        .await?;

        self.repository
            .get_filter_options(&query.collection_id, &collection.owner_id)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockall::mock;

    use crate::application::dtos::movie_dto::{
        CreateMovieDto, MovieDto, MovieListDto, UpdateMovieDto,
    };
    use crate::application::ports::movie_repository::ListMoviesParams;
    use crate::domain::movie::ContentType;

    mock! {
        FilterRepo {}
        #[async_trait::async_trait]
        impl MovieRepository for FilterRepo {
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

    fn make_filter_options() -> FilterOptionsDto {
        FilterOptionsDto {
            genres: vec!["Action".to_string(), "Drama".to_string()],
            content_types: vec![ContentType::Movie, ContentType::Series],
            rated: vec!["PG".to_string(), "R".to_string()],
            languages: vec!["English".to_string(), "French".to_string()],
            decades: vec![1990, 2000, 2010],
            owned_media: vec!["Blu-Ray".to_string()],
            rip_quality: vec!["DVD".to_string()],
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

    /// Handler whose collection mock is owned by `owner` (authorized via the
    /// Owner→Viewer hierarchy; the collection owner used for the read = `owner`).
    fn make_handler(repo: MockFilterRepo, owner: &'static str) -> GetFilterOptionsHandler {
        let mut coll = MockCollRepo::new();
        coll.expect_find_by_id()
            .returning(move |_| Ok(MovieCollection::new(owner, "C", None)));
        GetFilterOptionsHandler::new(Arc::new(repo), Arc::new(coll))
    }

    // T110 — returns filter options from repository

    #[tokio::test]
    async fn returns_filter_options_from_repository() {
        let mut mock_repo = MockFilterRepo::new();
        mock_repo
            .expect_get_filter_options()
            .returning(|_, _| Ok(make_filter_options()));

        let handler = make_handler(mock_repo, "user-1");
        let query = GetFilterOptionsQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
        };

        let result = handler.handle(query).await.unwrap();
        assert_eq!(result.genres, vec!["Action", "Drama"]);
        assert_eq!(result.decades, vec![1990, 2000, 2010]);
    }

    // T110 — collection and owner IDs forwarded correctly

    #[tokio::test]
    async fn collection_and_owner_ids_forwarded_correctly() {
        let mut mock_repo = MockFilterRepo::new();
        mock_repo
            .expect_get_filter_options()
            .withf(|coll_id, owner_id| coll_id == "coll-99" && owner_id == "user-42")
            .returning(|_, _| Ok(make_filter_options()));

        let handler = make_handler(mock_repo, "user-42");
        let query = GetFilterOptionsQuery {
            collection_id: "coll-99".to_string(),
            owner_id: "user-42".to_string(),
        };

        let result = handler.handle(query).await;
        assert!(result.is_ok());
    }

    // T110 — empty collection returns empty filter options

    #[tokio::test]
    async fn empty_collection_returns_empty_filter_options() {
        let mut mock_repo = MockFilterRepo::new();
        mock_repo.expect_get_filter_options().returning(|_, _| {
            Ok(FilterOptionsDto {
                genres: vec![],
                content_types: vec![],
                rated: vec![],
                languages: vec![],
                decades: vec![],
                owned_media: vec![],
                rip_quality: vec![],
            })
        });

        let handler = make_handler(mock_repo, "user-1");
        let query = GetFilterOptionsQuery {
            collection_id: "coll-empty".to_string(),
            owner_id: "user-1".to_string(),
        };

        let result = handler.handle(query).await.unwrap();
        assert!(result.genres.is_empty());
        assert!(result.content_types.is_empty());
        assert!(result.decades.is_empty());
    }

    // T110 — repository error propagates

    #[tokio::test]
    async fn repository_error_propagates() {
        let mut mock_repo = MockFilterRepo::new();
        mock_repo
            .expect_get_filter_options()
            .returning(|_, _| Err(DomainError::CollectionNotFound));

        let handler = make_handler(mock_repo, "user-1");
        let query = GetFilterOptionsQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
        };

        let result = handler.handle(query).await;
        assert!(matches!(result, Err(DomainError::CollectionNotFound)));
    }
}
