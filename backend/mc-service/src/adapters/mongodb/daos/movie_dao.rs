use bson::{oid::ObjectId, DateTime};
use serde::{Deserialize, Serialize};

use crate::domain::external_id::ExternalIdentifier;
use crate::domain::movie::{ContentType, MediaFormat, Movie, UsaRating};

/// BSON document representation of a movie.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MovieDao {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    #[serde(rename = "collectionId")]
    pub collection_id: ObjectId,
    #[serde(rename = "ownerId")]
    pub owner_id: String,
    pub title: String,
    /// 013 US9: article-insensitive sort key (lowercased title, leading a/an/the stripped).
    /// Maintained by the adapter on write; `default` covers pre-backfill documents on read.
    #[serde(rename = "titleSort", default)]
    pub title_sort: String,
    pub year: i32,
    #[serde(rename = "contentType")]
    pub content_type: String,
    /// Optional (014 US1). `#[serde(default)]` lets documents with no `language`
    /// field (future language-less movies) deserialize to `None`.
    #[serde(default)]
    pub language: Option<String>,
    pub owned: bool,
    pub ripped: bool,
    pub childrens: bool,
    #[serde(rename = "externalIds")]
    pub external_ids: Vec<ExternalIdDao>,
    #[serde(rename = "originalTitle")]
    pub original_title: Option<String>,
    #[serde(rename = "releaseDate")]
    pub release_date: Option<String>,
    pub outline: Option<String>,
    pub plot: Option<String>,
    pub runtime: Option<i32>,
    pub rated: Option<String>,
    pub directors: Vec<String>,
    pub actors: Vec<String>,
    #[serde(rename = "movieSet")]
    pub movie_set: Option<String>,
    pub tags: Vec<String>,
    pub genres: Vec<String>,
    #[serde(rename = "ownedMedia")]
    pub owned_media: Vec<String>,
    #[serde(rename = "ripQuality")]
    pub rip_quality: Vec<String>,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime,
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalIdDao {
    pub system: String,
    #[serde(rename = "uniqueId")]
    pub unique_id: String,
    pub url: Option<String>,
}

fn content_type_from_str(s: &str) -> ContentType {
    match s {
        "Series" => ContentType::Series,
        "Concert" => ContentType::Concert,
        _ => ContentType::Movie,
    }
}

fn media_format_from_str(s: &str) -> MediaFormat {
    match s {
        "Blu-Ray" => MediaFormat::BluRay,
        "Blu-Ray 3D" => MediaFormat::BluRay3D,
        "UHD Blu-Ray" => MediaFormat::UhdBluRay,
        _ => MediaFormat::Dvd,
    }
}

impl From<MovieDao> for Movie {
    fn from(dao: MovieDao) -> Self {
        Movie {
            id: dao.id.map(|id| id.to_hex()),
            collection_id: Some(dao.collection_id.to_hex()),
            owner_id: Some(dao.owner_id),
            title: dao.title,
            year: dao.year,
            content_type: content_type_from_str(&dao.content_type),
            language: dao.language,
            owned: dao.owned,
            ripped: dao.ripped,
            childrens: dao.childrens,
            original_title: dao.original_title,
            release_date: dao.release_date,
            outline: dao.outline,
            plot: dao.plot,
            runtime: dao.runtime,
            rated: dao.rated.as_deref().and_then(|r| match r {
                "G" => Some(UsaRating::G),
                "PG" => Some(UsaRating::PG),
                "PG-13" => Some(UsaRating::PG13),
                "R" => Some(UsaRating::R),
                "NC-17" => Some(UsaRating::NC17),
                "NR" => Some(UsaRating::NR),
                "Unrated" => Some(UsaRating::Unrated),
                _ => None,
            }),
            directors: dao.directors,
            actors: dao.actors,
            movie_set: dao.movie_set,
            tags: dao.tags,
            genres: dao.genres,
            owned_media: dao
                .owned_media
                .iter()
                .map(|s| media_format_from_str(s))
                .collect(),
            rip_quality: dao
                .rip_quality
                .iter()
                .map(|s| media_format_from_str(s))
                .collect(),
            external_ids: dao
                .external_ids
                .into_iter()
                .map(|e| ExternalIdentifier {
                    system: e.system,
                    unique_id: e.unique_id,
                    url: e.url,
                })
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bson::doc;

    /// A BSON document carrying every required DAO field. `language` is added by callers.
    fn base_doc() -> bson::Document {
        doc! {
            "collectionId": ObjectId::new(),
            "ownerId": "owner-1",
            "title": "The Matrix",
            "titleSort": "matrix",
            "year": 1999i32,
            "contentType": "Movie",
            "owned": false,
            "ripped": false,
            "childrens": false,
            "externalIds": [],
            "directors": [],
            "actors": [],
            "tags": [],
            "genres": [],
            "ownedMedia": [],
            "ripQuality": [],
            "createdAt": DateTime::now(),
            "updatedAt": DateTime::now(),
        }
    }

    #[test]
    fn deserializes_document_with_no_language_field() {
        // 014 US1 (T009): a document missing `language` must deserialize to `None`
        // via `#[serde(default)]`, not error on a missing field.
        let dao: MovieDao =
            bson::from_document(base_doc()).expect("doc with no language must deserialize");
        assert_eq!(dao.language, None);
    }

    #[test]
    fn deserializes_document_with_language_field() {
        let mut d = base_doc();
        d.insert("language", "English");
        let dao: MovieDao = bson::from_document(d).expect("doc with language must deserialize");
        assert_eq!(dao.language, Some("English".to_string()));
    }
}
