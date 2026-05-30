use async_trait::async_trait;

use crate::application::dtos::movie_dto::{
    CreateMovieDto, FilterOptionsDto, MovieDto, MovieListDto, UpdateMovieDto,
};
use crate::domain::errors::DomainError;

/// Query parameters for the movie list endpoint.
#[derive(Debug, Clone, Default)]
pub struct ListMoviesParams {
    pub cursor: Option<String>,
    pub search: Option<String>,
    pub content_type: Option<String>,
    pub genres: Vec<String>,
    pub childrens: Option<bool>,
    pub rated: Option<String>,
    pub language: Option<String>,
    pub decade: Option<i32>,
    pub owned: Option<bool>,
    pub owned_media: Vec<String>,
    pub ripped: Option<bool>,
    pub rip_quality: Vec<String>,
}

/// Repository interface (port) for movie persistence.
/// Implemented by the MongoDB adapter in the Adapters layer.
#[async_trait]
pub trait MovieRepository: Send + Sync {
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
