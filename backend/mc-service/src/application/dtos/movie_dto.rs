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
    /// Optional (014 US1): absent/null when the movie has no recorded language.
    #[serde(default)]
    pub language: Option<String>,
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
    /// Optional (014 US1): omit or null to create a movie with no language.
    #[serde(default)]
    pub language: Option<String>,
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
    /// Optional (014 US1): omit or null on a full-replace PUT to clear the language.
    #[serde(default)]
    pub language: Option<String>,
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

/// The option values this service accepts for a movie, published so clients need not hold a copy
/// (047 US4 / RQ-4).
///
/// Distinct from `FilterOptionsDto`, which reports the values OBSERVED in one collection — an
/// empty collection yields empty lists there, and a collection of DVDs would hide Blu-Ray. This
/// DTO answers "what may I choose", not "what can I filter by here".
///
/// An object rather than a bare array so further enumerations (content types, ratings) can be
/// published later additively rather than as a breaking change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MovieMetadataDto {
    /// Every accepted `MediaFormat`, in display order, as its serde WIRE value ("Blu-Ray", not
    /// "BluRay"). Used for BOTH `ownedMedia` and `ripQuality` — they share the enum.
    pub media_formats: Vec<String>,
}

impl MovieMetadataDto {
    /// Build from the domain enum. Derived, never hand-listed — see `MediaFormat::all()`.
    pub fn from_domain() -> Self {
        Self {
            media_formats: MediaFormat::all()
                .iter()
                .map(MediaFormat::wire_value)
                .collect(),
        }
    }
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

#[cfg(test)]
mod movie_metadata_dto_tests {
    use super::*;

    /// The contract's example body (contracts/movie-metadata.md §1): an OBJECT keyed
    /// `mediaFormats`, carrying the wire values in display order.
    #[test]
    fn movie_metadata_dto_serializes_to_the_contract_shape() {
        let json = serde_json::to_value(MovieMetadataDto::from_domain()).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "mediaFormats": ["DVD", "Blu-Ray", "Blu-Ray 3D", "UHD Blu-Ray"]
            })
        );
    }

    /// camelCase on the wire, matching every other DTO this service returns.
    #[test]
    fn movie_metadata_dto_uses_camel_case_keys() {
        let json = serde_json::to_string(&MovieMetadataDto::from_domain()).expect("serialize");
        assert!(
            json.contains("mediaFormats"),
            "expected camelCase key, got {json}"
        );
        assert!(
            !json.contains("media_formats"),
            "snake_case leaked to the wire: {json}"
        );
    }

    /// The published list is DERIVED from the domain, not a second copy of it. If these ever
    /// disagree, clients are being offered values this service would reject.
    #[test]
    fn movie_metadata_dto_matches_the_domain_enum_exactly() {
        let dto = MovieMetadataDto::from_domain();
        let expected: Vec<String> = MediaFormat::all()
            .iter()
            .map(MediaFormat::wire_value)
            .collect();
        assert_eq!(dto.media_formats, expected);
        assert_eq!(dto.media_formats.len(), MediaFormat::all().len());
    }

    /// Every published value must be one `add_movie` accepts — a member's pick must be storable.
    #[test]
    fn movie_metadata_dto_values_round_trip_into_media_format() {
        for value in MovieMetadataDto::from_domain().media_formats {
            let quoted = format!("\"{value}\"");
            serde_json::from_str::<MediaFormat>(&quoted)
                .unwrap_or_else(|e| panic!("published value {value:?} is not accepted: {e}"));
        }
    }
}
