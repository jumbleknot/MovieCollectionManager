use std::sync::Arc;

use crate::application::dtos::movie_dto::FilterOptionsDto;
use crate::application::ports::movie_repository::MovieRepository;
use crate::domain::errors::DomainError;

pub struct GetFilterOptionsQuery {
    pub collection_id: String,
    pub owner_id: String,
}

pub struct GetFilterOptionsHandler {
    pub repository: Arc<dyn MovieRepository>,
}

impl GetFilterOptionsHandler {
    pub fn new(repository: Arc<dyn MovieRepository>) -> Self {
        Self { repository }
    }

    pub async fn handle(
        &self,
        query: GetFilterOptionsQuery,
    ) -> Result<FilterOptionsDto, DomainError> {
        self.repository
            .get_filter_options(&query.collection_id, &query.owner_id)
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

    // T110 — returns filter options from repository

    #[tokio::test]
    async fn returns_filter_options_from_repository() {
        let mut mock_repo = MockFilterRepo::new();
        mock_repo
            .expect_get_filter_options()
            .returning(|_, _| Ok(make_filter_options()));

        let handler = GetFilterOptionsHandler::new(Arc::new(mock_repo));
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

        let handler = GetFilterOptionsHandler::new(Arc::new(mock_repo));
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

        let handler = GetFilterOptionsHandler::new(Arc::new(mock_repo));
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

        let handler = GetFilterOptionsHandler::new(Arc::new(mock_repo));
        let query = GetFilterOptionsQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
        };

        let result = handler.handle(query).await;
        assert!(matches!(result, Err(DomainError::CollectionNotFound)));
    }
}
