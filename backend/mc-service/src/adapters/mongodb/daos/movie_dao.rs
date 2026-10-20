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
        let dao: MovieDao = bson::deserialize_from_document(base_doc())
            .expect("doc with no language must deserialize");
        assert_eq!(dao.language, None);
    }

    #[test]
    fn deserializes_document_with_language_field() {
        let mut d = base_doc();
        d.insert("language", "English");
        let dao: MovieDao =
            bson::deserialize_from_document(d).expect("doc with language must deserialize");
        assert_eq!(dao.language, Some("English".to_string()));
    }

    /// Decode the hex of a fixture (no `hex` dev-dependency for one helper).
    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
            .collect()
    }

    /// 081 US9 PR 9a: the exact bytes **bson 2.15.0** wrote for a fully-populated movie (every
    /// optional field both present and null, nested external-id documents, string arrays, i32s,
    /// bools, ObjectIds and both DateTimes) — generated once from bson 2.15.0 with this struct's
    /// definition. Every document already in production was written by that serializer, so it
    /// must still decode through the driver's raw path, and a re-write must be byte-identical.
    const BSON2_MOVIE_HEX: &str = "\
        e5020000075f69640065f0c0ffee0000000000abcd07636f6c6c656374696f6e49640065f0c0ffee0000000000c01102\
        6f776e6572496400080000006f776e65722d3100027469746c65000b000000546865204d617472697800027469746c65\
        536f727400070000006d617472697800107965617200cf07000002636f6e74656e745479706500060000004d6f766965\
        00026c616e67756167650008000000456e676c69736800086f776e65640001087269707065640001086368696c647265\
        6e7300000465787465726e616c49647300950000000330005d0000000273797374656d0005000000696d64620002756e\
        697175654964000a000000747430313333303933000275726c002600000068747470733a2f2f7777772e696d64622e63\
        6f6d2f7469746c652f7474303133333039332f00000331002d0000000273797374656d0005000000746d64620002756e\
        6971756549640004000000363033000a75726c000000026f726967696e616c5469746c65000b000000546865204d6174\
        726978000272656c6561736544617465000b000000313939392d30332d333100026f75746c696e6500020000006f000a\
        706c6f74001072756e74696d65008800000002726174656400020000005200046469726563746f727300320000000230\
        000f0000004c616e6120576163686f77736b6900023100100000004c696c6c7920576163686f77736b69000004616374\
        6f727300190000000230000d0000004b65616e752052656576657300000a6d6f76696553657400047461677300050000\
        00000467656e7265730021000000023000070000005363692d46690002310007000000416374696f6e0000046f776e65\
        644d65646961002700000002300008000000426c752d526179000231000c00000055484420426c752d52617900000472\
        69705175616c697479001400000002300008000000426c752d526179000009637265617465644174007b68e5cf8b0100\
        00097570646174656441740020a8f4cf8b01000000\
    ";

    #[test]
    fn decodes_a_movie_written_by_bson_2_and_rewrites_identical_bytes() {
        let bytes = unhex(BSON2_MOVIE_HEX);
        let dao: MovieDao = bson::deserialize_from_slice(&bytes).expect("bson-2 bytes decode");
        assert_eq!(dao.id.unwrap().to_hex(), "65f0c0ffee0000000000abcd");
        assert_eq!(dao.collection_id.to_hex(), "65f0c0ffee0000000000c011");
        assert_eq!(dao.title_sort, "matrix");
        assert_eq!(dao.year, 1999);
        assert_eq!(dao.language.as_deref(), Some("English"));
        assert!(dao.owned && dao.ripped && !dao.childrens);
        assert_eq!(dao.external_ids.len(), 2);
        assert_eq!(dao.external_ids[1].url, None);
        assert_eq!(dao.plot, None);
        assert_eq!(dao.runtime, Some(136));
        assert_eq!(dao.owned_media, vec!["Blu-Ray", "UHD Blu-Ray"]);
        assert_eq!(dao.created_at.timestamp_millis(), 1_700_000_000_123);
        assert_eq!(dao.updated_at.timestamp_millis(), 1_700_000_999_456);

        let rewritten = bson::serialize_to_vec(&dao).expect("serialize");
        assert_eq!(rewritten, bytes, "bson 3 writes the bytes bson 2 wrote");
        let raw = bson::serialize_to_raw_document_buf(&dao).expect("raw serialize");
        assert_eq!(
            raw.as_bytes(),
            bytes.as_slice(),
            "the driver's insert path too"
        );
    }
}
