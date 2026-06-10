use serde::{Deserialize, Serialize};

use crate::domain::external_id::ExternalIdentifier;
use crate::domain::movie::{ContentType, MediaFormat, UsaRating};

/// Full movie representation returned to the client.
///
/// Serialized to camelCase JSON per the mc-service API contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovieDto {
    /// Serialized as `movieId` in JSON.
    #[serde(rename = "movieId")]
    pub id: String,
    pub collection_id: String,
    pub title: String,
    pub year: i32,
    pub content_type: ContentType,
    pub language: String,
    pub owned: bool,
    pub ripped: bool,
    pub childrens: bool,
    pub original_title: Option<String>,
    pub release_date: Option<String>,
    pub outline: Option<String>,
    pub plot: Option<String>,
    pub runtime: Option<i32>,
    pub rated: Option<UsaRating>,
    pub directors: Vec<String>,
    pub actors: Vec<String>,
    pub movie_set: Option<String>,
    pub tags: Vec<String>,
    pub genres: Vec<String>,
    pub owned_media: Vec<MediaFormat>,
    pub rip_quality: Vec<MediaFormat>,
    pub external_ids: Vec<ExternalIdentifier>,
    pub created_at: String,
    pub updated_at: String,
}

/// Request body for creating a new movie.
///
/// Deserializes from camelCase JSON (client sends `contentType`, `ownedMedia`, etc.).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMovieDto {
    pub title: String,
    pub year: i32,
    pub content_type: ContentType,
    pub language: String,
    pub owned: bool,
    pub ripped: bool,
    pub childrens: bool,
    pub original_title: Option<String>,
    pub release_date: Option<String>,
    pub outline: Option<String>,
    pub plot: Option<String>,
    pub runtime: Option<i32>,
    pub rated: Option<UsaRating>,
    pub directors: Vec<String>,
    pub actors: Vec<String>,
    pub movie_set: Option<String>,
    pub tags: Vec<String>,
    pub genres: Vec<String>,
    pub owned_media: Vec<MediaFormat>,
    pub rip_quality: Vec<MediaFormat>,
    pub external_ids: Vec<ExternalIdentifier>,
}

/// Request body for updating a movie (full replacement — PUT semantics).
///
/// Deserializes from camelCase JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMovieDto {
    pub title: String,
    pub year: i32,
    pub content_type: ContentType,
    pub language: String,
    pub owned: bool,
    pub ripped: bool,
    pub childrens: bool,
    pub original_title: Option<String>,
    pub release_date: Option<String>,
    pub outline: Option<String>,
    pub plot: Option<String>,
    pub runtime: Option<i32>,
    pub rated: Option<UsaRating>,
    pub directors: Vec<String>,
    pub actors: Vec<String>,
    pub movie_set: Option<String>,
    pub tags: Vec<String>,
    pub genres: Vec<String>,
    pub owned_media: Vec<MediaFormat>,
    pub rip_quality: Vec<MediaFormat>,
    pub external_ids: Vec<ExternalIdentifier>,
}

/// Paginated movie list response envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovieListDto {
    pub items: Vec<MovieDto>,
    pub next_cursor: Option<String>,
}

/// Movie count for a collection matching a filter (US4) — serialized as `{ "count": N }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MovieCountDto {
    pub count: u64,
}

/// Filter options derived from actual values present in a collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterOptionsDto {
    pub genres: Vec<String>,
    pub content_types: Vec<ContentType>,
    pub rated: Vec<String>,
    pub languages: Vec<String>,
    pub decades: Vec<i32>,
    pub owned_media: Vec<String>,
    pub rip_quality: Vec<String>,
}
