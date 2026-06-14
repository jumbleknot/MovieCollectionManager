use serde::{Deserialize, Serialize};

use crate::domain::external_id::ExternalIdentifier;

/// Content type classification for a movie entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ContentType {
    Movie,
    Series,
    Concert,
}

/// Physical media format for owned/ripped media.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MediaFormat {
    #[serde(rename = "DVD")]
    Dvd,
    #[serde(rename = "Blu-Ray")]
    BluRay,
    #[serde(rename = "Blu-Ray 3D")]
    BluRay3D,
    #[serde(rename = "UHD Blu-Ray")]
    UhdBluRay,
}

/// MPAA/USA content rating.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum UsaRating {
    G,
    PG,
    #[serde(rename = "PG-13")]
    PG13,
    R,
    #[serde(rename = "NC-17")]
    NC17,
    NR,
    Unrated,
}

/// A movie record belonging to a collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Movie {
    /// MongoDB ObjectId as hex string (None for new, unsaved movies)
    pub id: Option<String>,
    /// Collection this movie belongs to
    pub collection_id: Option<String>,
    /// Denormalized owner ID for access control
    pub owner_id: Option<String>,

    // Required fields
    pub title: String,
    pub year: i32,
    pub content_type: ContentType,
    /// Optional (014 US1): "unknown language" is modelled as absence, not an empty string.
    pub language: Option<String>,
    pub owned: bool,
    pub ripped: bool,
    pub childrens: bool,

    // Optional fields
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

    // Cross-field constrained fields
    pub owned_media: Vec<MediaFormat>,
    pub rip_quality: Vec<MediaFormat>,

    // External identifiers
    pub external_ids: Vec<ExternalIdentifier>,
}

impl Movie {
    /// Create a new (unsaved) Movie with required fields.
    /// Cross-field invariants are enforced: if `owned` is false, `owned_media` is cleared;
    /// if `ripped` is false, `rip_quality` is cleared.
    pub fn new(
        title: impl Into<String>,
        year: i32,
        content_type: ContentType,
        language: Option<String>,
        owned: bool,
        ripped: bool,
        childrens: bool,
    ) -> Self {
        Self {
            id: None,
            collection_id: None,
            owner_id: None,
            title: title.into(),
            year,
            content_type,
            language,
            owned,
            ripped,
            childrens,
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
        }
    }

    /// Set `owned_media`, enforcing the cross-field invariant.
    /// If `owned` is false, clears the list regardless of input.
    pub fn set_owned_media(&mut self, media: Vec<MediaFormat>) {
        self.owned_media = if self.owned { media } else { vec![] };
    }

    /// Set `rip_quality`, enforcing the cross-field invariant.
    /// If `ripped` is false, clears the list regardless of input.
    pub fn set_rip_quality(&mut self, quality: Vec<MediaFormat>) {
        self.rip_quality = if self.ripped { quality } else { vec![] };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // T068

    #[test]
    fn new_movie_has_correct_required_fields() {
        let movie = Movie::new(
            "Inception",
            2010,
            ContentType::Movie,
            Some("English".to_string()),
            true,
            false,
            false,
        );
        assert_eq!(movie.title, "Inception");
        assert_eq!(movie.year, 2010);
        assert_eq!(movie.content_type, ContentType::Movie);
        assert_eq!(movie.language, Some("English".to_string()));
        assert!(movie.owned);
        assert!(!movie.ripped);
        assert!(!movie.childrens);
    }

    #[test]
    fn new_movie_optional_fields_are_none_or_empty() {
        let movie = Movie::new(
            "Test",
            2000,
            ContentType::Series,
            Some("French".to_string()),
            false,
            false,
            false,
        );
        assert!(movie.original_title.is_none());
        assert!(movie.outline.is_none());
        assert!(movie.directors.is_empty());
        assert!(movie.genres.is_empty());
        assert!(movie.owned_media.is_empty());
        assert!(movie.rip_quality.is_empty());
    }

    #[test]
    fn set_owned_media_clears_when_owned_is_false() {
        let mut movie = Movie::new(
            "Test",
            2000,
            ContentType::Movie,
            Some("English".to_string()),
            false,
            false,
            false,
        );
        movie.set_owned_media(vec![MediaFormat::BluRay]);
        assert!(
            movie.owned_media.is_empty(),
            "owned_media should be empty when owned=false"
        );
    }

    #[test]
    fn set_owned_media_persists_when_owned_is_true() {
        let mut movie = Movie::new(
            "Test",
            2000,
            ContentType::Movie,
            Some("English".to_string()),
            true,
            false,
            false,
        );
        movie.set_owned_media(vec![MediaFormat::BluRay]);
        assert_eq!(movie.owned_media, vec![MediaFormat::BluRay]);
    }

    #[test]
    fn set_rip_quality_clears_when_ripped_is_false() {
        let mut movie = Movie::new(
            "Test",
            2000,
            ContentType::Movie,
            Some("English".to_string()),
            false,
            false,
            false,
        );
        movie.set_rip_quality(vec![MediaFormat::Dvd]);
        assert!(
            movie.rip_quality.is_empty(),
            "rip_quality should be empty when ripped=false"
        );
    }

    #[test]
    fn set_rip_quality_persists_when_ripped_is_true() {
        let mut movie = Movie::new(
            "Test",
            2000,
            ContentType::Movie,
            Some("English".to_string()),
            false,
            true,
            false,
        );
        movie.set_rip_quality(vec![MediaFormat::UhdBluRay]);
        assert_eq!(movie.rip_quality, vec![MediaFormat::UhdBluRay]);
    }
}
