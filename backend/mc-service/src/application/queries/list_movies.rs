use std::sync::Arc;

use crate::application::dtos::movie_dto::MovieListDto;
use crate::application::ports::movie_repository::{ListMoviesParams, MovieRepository};
use crate::domain::errors::DomainError;

pub struct ListMoviesQuery {
    pub collection_id: String,
    pub owner_id: String,
    pub params: ListMoviesParams,
}

pub struct ListMoviesHandler {
    pub repository: Arc<dyn MovieRepository>,
}

impl ListMoviesHandler {
    pub fn new(repository: Arc<dyn MovieRepository>) -> Self {
        Self { repository }
    }

    pub async fn handle(&self, query: ListMoviesQuery) -> Result<MovieListDto, DomainError> {
        self.repository
            .list(&query.collection_id, &query.owner_id, query.params)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockall::mock;
    use mockall::predicate::*;

    use crate::application::dtos::movie_dto::{
        CreateMovieDto, FilterOptionsDto, MovieDto, UpdateMovieDto,
    };
    use crate::domain::movie::ContentType;

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

    fn make_movie_dto(id: &str, title: &str) -> MovieDto {
        MovieDto {
            id: id.to_string(),
            collection_id: "coll-1".to_string(),
            title: title.to_string(),
            year: 2024,
            content_type: ContentType::Movie,
            language: "English".to_string(),
            owned: false,
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
            created_at: "2026-01-01T00:00:00Z".to_string(),
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    // T108 — cursor pagination advances page

    #[tokio::test]
    async fn cursor_pagination_forwarded_to_repository() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo
            .expect_list()
            .withf(|coll_id, owner_id, params| {
                coll_id == "coll-1"
                    && owner_id == "user-1"
                    && params.cursor.as_deref() == Some("cursor-abc")
            })
            .returning(|_, _, _| {
                Ok(MovieListDto {
                    items: vec![make_movie_dto("mov-2", "Movie Two")],
                    next_cursor: Some("cursor-xyz".to_string()),
                })
            });

        let handler = ListMoviesHandler::new(Arc::new(mock_repo));
        let query = ListMoviesQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
            params: ListMoviesParams {
                cursor: Some("cursor-abc".to_string()),
                ..Default::default()
            },
        };

        let result = handler.handle(query).await.unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].title, "Movie Two");
        assert_eq!(result.next_cursor.as_deref(), Some("cursor-xyz"));
    }

    // T108 — search term narrows results

    #[tokio::test]
    async fn search_term_forwarded_to_repository() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo
            .expect_list()
            .withf(|_, _, params| params.search.as_deref() == Some("inception"))
            .returning(|_, _, _| {
                Ok(MovieListDto {
                    items: vec![make_movie_dto("mov-10", "Inception")],
                    next_cursor: None,
                })
            });

        let handler = ListMoviesHandler::new(Arc::new(mock_repo));
        let query = ListMoviesQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
            params: ListMoviesParams {
                search: Some("inception".to_string()),
                ..Default::default()
            },
        };

        let result = handler.handle(query).await.unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].title, "Inception");
    }

    // T108 — individual filter: content_type

    #[tokio::test]
    async fn content_type_filter_forwarded_to_repository() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo
            .expect_list()
            .withf(|_, _, params| params.content_type.as_deref() == Some("Series"))
            .returning(|_, _, _| {
                Ok(MovieListDto {
                    items: vec![make_movie_dto("mov-5", "Breaking Bad")],
                    next_cursor: None,
                })
            });

        let handler = ListMoviesHandler::new(Arc::new(mock_repo));
        let query = ListMoviesQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
            params: ListMoviesParams {
                content_type: Some("Series".to_string()),
                ..Default::default()
            },
        };

        let result = handler.handle(query).await.unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].title, "Breaking Bad");
    }

    // T108 — individual filter: genres

    #[tokio::test]
    async fn genres_filter_forwarded_to_repository() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo
            .expect_list()
            .withf(|_, _, params| params.genres == vec!["Action".to_string()])
            .returning(|_, _, _| {
                Ok(MovieListDto {
                    items: vec![make_movie_dto("mov-6", "Die Hard")],
                    next_cursor: None,
                })
            });

        let handler = ListMoviesHandler::new(Arc::new(mock_repo));
        let query = ListMoviesQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
            params: ListMoviesParams {
                genres: vec!["Action".to_string()],
                ..Default::default()
            },
        };

        let result = handler.handle(query).await.unwrap();
        assert_eq!(result.items[0].title, "Die Hard");
    }

    // T108 — individual filter: owned

    #[tokio::test]
    async fn owned_filter_forwarded_to_repository() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo
            .expect_list()
            .withf(|_, _, params| params.owned == Some(true))
            .returning(|_, _, _| {
                Ok(MovieListDto {
                    items: vec![make_movie_dto("mov-7", "Owned Movie")],
                    next_cursor: None,
                })
            });

        let handler = ListMoviesHandler::new(Arc::new(mock_repo));
        let query = ListMoviesQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
            params: ListMoviesParams {
                owned: Some(true),
                ..Default::default()
            },
        };

        let result = handler.handle(query).await.unwrap();
        assert_eq!(result.items[0].title, "Owned Movie");
    }

    // T108 — combined search + filter intersects correctly

    #[tokio::test]
    async fn combined_search_and_filter_forwarded_to_repository() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo
            .expect_list()
            .withf(|_, _, params| {
                params.search.as_deref() == Some("star")
                    && params.content_type.as_deref() == Some("Movie")
                    && params.genres == vec!["Sci-Fi".to_string()]
                    && params.owned == Some(true)
            })
            .returning(|_, _, _| {
                Ok(MovieListDto {
                    items: vec![make_movie_dto("mov-8", "Star Wars")],
                    next_cursor: None,
                })
            });

        let handler = ListMoviesHandler::new(Arc::new(mock_repo));
        let query = ListMoviesQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
            params: ListMoviesParams {
                search: Some("star".to_string()),
                content_type: Some("Movie".to_string()),
                genres: vec!["Sci-Fi".to_string()],
                owned: Some(true),
                ..Default::default()
            },
        };

        let result = handler.handle(query).await.unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].title, "Star Wars");
    }

    // T108 — empty result set

    #[tokio::test]
    async fn empty_result_set_returned_correctly() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo.expect_list().returning(|_, _, _| {
            Ok(MovieListDto {
                items: vec![],
                next_cursor: None,
            })
        });

        let handler = ListMoviesHandler::new(Arc::new(mock_repo));
        let query = ListMoviesQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
            params: ListMoviesParams::default(),
        };

        let result = handler.handle(query).await.unwrap();
        assert!(result.items.is_empty());
        assert!(result.next_cursor.is_none());
    }

    // T108 — collection and owner IDs forwarded correctly

    #[tokio::test]
    async fn collection_and_owner_ids_forwarded_correctly() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo
            .expect_list()
            .withf(|coll_id, owner_id, _| coll_id == "coll-99" && owner_id == "user-42")
            .returning(|_, _, _| {
                Ok(MovieListDto {
                    items: vec![],
                    next_cursor: None,
                })
            });

        let handler = ListMoviesHandler::new(Arc::new(mock_repo));
        let query = ListMoviesQuery {
            collection_id: "coll-99".to_string(),
            owner_id: "user-42".to_string(),
            params: ListMoviesParams::default(),
        };

        let result = handler.handle(query).await;
        assert!(result.is_ok());
    }

    // T108 — repository error propagates

    #[tokio::test]
    async fn repository_error_propagates() {
        let mut mock_repo = MockMovieRepo::new();
        mock_repo
            .expect_list()
            .returning(|_, _, _| Err(DomainError::CollectionNotFound));

        let handler = ListMoviesHandler::new(Arc::new(mock_repo));
        let query = ListMoviesQuery {
            collection_id: "coll-1".to_string(),
            owner_id: "user-1".to_string(),
            params: ListMoviesParams::default(),
        };

        let result = handler.handle(query).await;
        assert!(matches!(result, Err(DomainError::CollectionNotFound)));
    }
}
