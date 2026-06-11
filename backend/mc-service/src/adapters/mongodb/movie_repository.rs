use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use bson::{doc, oid::ObjectId, DateTime};
use mongodb::{Collection, Database};

use crate::adapters::mongodb::daos::movie_dao::{ExternalIdDao, MovieDao};
use crate::application::dtos::movie_dto::{
    CreateMovieDto, FilterOptionsDto, MovieDto, MovieListDto, UpdateMovieDto,
};
use crate::application::ports::movie_repository::{ListMoviesParams, MovieRepository};
use crate::domain::errors::DomainError;
use crate::domain::external_id::ExternalIdentifier;
use crate::domain::movie::{ContentType, MediaFormat, UsaRating};

/// Escape special PCRE metacharacters so the string is matched literally in a
/// MongoDB `$regex` query.  We avoid the `regex` crate to keep the dependency
/// footprint small; the character set matches the PCRE/ECMAScript spec.
fn escape_for_regex(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        if r"\^$.|?*+()[]{}".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

pub struct MongoMovieRepository {
    collection: Collection<MovieDao>,
}

impl MongoMovieRepository {
    pub fn new(db: &Database) -> Self {
        Self {
            collection: db.collection("movies"),
        }
    }
}

fn parse_oid(id: &str) -> Result<ObjectId, DomainError> {
    ObjectId::parse_str(id).map_err(|_| DomainError::MovieNotFound)
}

fn parse_coll_oid(id: &str) -> Result<ObjectId, DomainError> {
    ObjectId::parse_str(id).map_err(|_| DomainError::CollectionNotFound)
}

fn is_duplicate_key(err: &mongodb::error::Error) -> bool {
    matches!(err.kind.as_ref(), mongodb::error::ErrorKind::Write(
        mongodb::error::WriteFailure::WriteError(we)
    ) if we.code == 11000)
}

fn content_type_to_str(ct: &ContentType) -> &'static str {
    match ct {
        ContentType::Movie => "Movie",
        ContentType::Series => "Series",
        ContentType::Concert => "Concert",
    }
}

fn media_format_to_str(mf: &MediaFormat) -> &'static str {
    match mf {
        MediaFormat::Dvd => "DVD",
        MediaFormat::BluRay => "Blu-Ray",
        MediaFormat::BluRay3D => "Blu-Ray 3D",
        MediaFormat::UhdBluRay => "UHD Blu-Ray",
    }
}

fn rating_to_str(r: &UsaRating) -> &'static str {
    match r {
        UsaRating::G => "G",
        UsaRating::PG => "PG",
        UsaRating::PG13 => "PG-13",
        UsaRating::R => "R",
        UsaRating::NC17 => "NC-17",
        UsaRating::NR => "NR",
        UsaRating::Unrated => "Unrated",
    }
}

fn dao_to_dto(dao: MovieDao) -> MovieDto {
    use crate::domain::movie::{ContentType, MediaFormat, UsaRating};

    MovieDto {
        id: dao.id.map(|id| id.to_hex()).unwrap_or_default(),
        collection_id: dao.collection_id.to_hex(),
        title: dao.title,
        year: dao.year,
        content_type: match dao.content_type.as_str() {
            "Series" => ContentType::Series,
            "Concert" => ContentType::Concert,
            _ => ContentType::Movie,
        },
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
            .map(|s| match s.as_str() {
                "Blu-Ray" => MediaFormat::BluRay,
                "Blu-Ray 3D" => MediaFormat::BluRay3D,
                "UHD Blu-Ray" => MediaFormat::UhdBluRay,
                _ => MediaFormat::Dvd,
            })
            .collect(),
        rip_quality: dao
            .rip_quality
            .iter()
            .map(|s| match s.as_str() {
                "Blu-Ray" => MediaFormat::BluRay,
                "Blu-Ray 3D" => MediaFormat::BluRay3D,
                "UHD Blu-Ray" => MediaFormat::UhdBluRay,
                _ => MediaFormat::Dvd,
            })
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
        created_at: dao.created_at.to_string(),
        updated_at: dao.updated_at.to_string(),
    }
}

fn encode_cursor(oid: &ObjectId) -> String {
    STANDARD.encode(oid.to_hex())
}

fn decode_cursor(cursor: &str) -> Option<ObjectId> {
    let hex = String::from_utf8(STANDARD.decode(cursor).ok()?).ok()?;
    ObjectId::parse_str(&hex).ok()
}

/// Build the Mongo filter for a movie query from `ListMoviesParams` — the structural filter
/// shared by `list` and `count` so they ALWAYS agree (US4 / FR-023). Excludes the pagination
/// `cursor` (list-only). Mirrors the on-screen filter dimensions.
fn build_movie_filter(coll_oid: ObjectId, owner_id: &str, params: &ListMoviesParams) -> bson::Document {
    let mut filter = doc! { "collectionId": coll_oid, "ownerId": owner_id };

    // Substring search (case-insensitive $regex, not $text — partial-word matches as users expect).
    if let Some(ref search) = params.search {
        let pattern = escape_for_regex(search);
        let make_re = || bson::Regex {
            pattern: pattern.clone(),
            options: "i".to_string(),
        };
        filter.insert(
            "$or",
            bson::Bson::Array(vec![
                doc! { "title":         { "$regex": make_re() } }.into(),
                doc! { "originalTitle": { "$regex": make_re() } }.into(),
                doc! { "directors":     { "$regex": make_re() } }.into(),
                doc! { "actors":        { "$regex": make_re() } }.into(),
                doc! { "movieSet":      { "$regex": make_re() } }.into(),
                doc! { "tags":          { "$regex": make_re() } }.into(),
                doc! { "outline":       { "$regex": make_re() } }.into(),
                doc! { "plot":          { "$regex": make_re() } }.into(),
            ]),
        );
    }

    if let Some(ref ct) = params.content_type {
        filter.insert("contentType", ct.as_str());
    }
    if !params.genres.is_empty() {
        filter.insert("genres", doc! { "$in": &params.genres });
    }
    if let Some(childrens) = params.childrens {
        filter.insert("childrens", childrens);
    }
    if let Some(ref rated) = params.rated {
        filter.insert("rated", rated.as_str());
    }
    if let Some(ref lang) = params.language {
        filter.insert("language", lang.as_str());
    }
    if let Some(decade) = params.decade {
        filter.insert("year", doc! { "$gte": decade, "$lte": decade + 9 });
    }
    if let Some(owned) = params.owned {
        filter.insert("owned", owned);
    }
    if !params.owned_media.is_empty() {
        filter.insert("ownedMedia", doc! { "$in": &params.owned_media });
    }
    if let Some(ripped) = params.ripped {
        filter.insert("ripped", ripped);
    }
    if !params.rip_quality.is_empty() {
        filter.insert("ripQuality", doc! { "$in": &params.rip_quality });
    }

    filter
}

#[async_trait]
impl MovieRepository for MongoMovieRepository {
    async fn create(
        &self,
        collection_id: &str,
        owner_id: &str,
        dto: CreateMovieDto,
    ) -> Result<MovieDto, DomainError> {
        let coll_oid = parse_coll_oid(collection_id)?;
        let now = DateTime::now();

        let dao = MovieDao {
            id: None,
            collection_id: coll_oid,
            owner_id: owner_id.to_string(),
            title: dto.title.clone(),
            year: dto.year,
            content_type: content_type_to_str(&dto.content_type).to_string(),
            language: dto.language.clone(),
            owned: dto.owned,
            ripped: dto.ripped,
            childrens: dto.childrens,
            original_title: dto.original_title.clone(),
            release_date: dto.release_date.clone(),
            outline: dto.outline.clone(),
            plot: dto.plot.clone(),
            runtime: dto.runtime,
            rated: dto.rated.as_ref().map(|r| rating_to_str(r).to_string()),
            directors: dto.directors.clone(),
            actors: dto.actors.clone(),
            movie_set: dto.movie_set.clone(),
            tags: dto.tags.clone(),
            genres: dto.genres.clone(),
            owned_media: dto
                .owned_media
                .iter()
                .map(|m| media_format_to_str(m).to_string())
                .collect(),
            rip_quality: dto
                .rip_quality
                .iter()
                .map(|m| media_format_to_str(m).to_string())
                .collect(),
            external_ids: dto
                .external_ids
                .iter()
                .map(|e| ExternalIdDao {
                    system: e.system.clone(),
                    unique_id: e.unique_id.clone(),
                    url: e.url.clone(),
                })
                .collect(),
            created_at: now,
            updated_at: now,
        };

        let result = self.collection.insert_one(dao).await.map_err(|e| {
            if is_duplicate_key(&e) {
                DomainError::DuplicateMovie
            } else {
                DomainError::Internal(e.to_string())
            }
        })?;

        let new_id = result
            .inserted_id
            .as_object_id()
            .ok_or_else(|| DomainError::Internal("Insert did not return ObjectId".to_string()))?;

        // Fetch the newly created document
        let filter = doc! { "_id": new_id };
        let dao = self
            .collection
            .find_one(filter)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
            .ok_or(DomainError::MovieNotFound)?;

        Ok(dao_to_dto(dao))
    }

    async fn get_by_id(
        &self,
        collection_id: &str,
        movie_id: &str,
        owner_id: &str,
    ) -> Result<MovieDto, DomainError> {
        let coll_oid = parse_coll_oid(collection_id)?;
        let movie_oid = parse_oid(movie_id)?;
        let filter = doc! { "_id": movie_oid, "collectionId": coll_oid, "ownerId": owner_id };
        let dao = self
            .collection
            .find_one(filter)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
            .ok_or(DomainError::MovieNotFound)?;
        Ok(dao_to_dto(dao))
    }

    async fn update(
        &self,
        collection_id: &str,
        movie_id: &str,
        owner_id: &str,
        dto: UpdateMovieDto,
    ) -> Result<MovieDto, DomainError> {
        let coll_oid = parse_coll_oid(collection_id)?;
        let movie_oid = parse_oid(movie_id)?;
        let filter = doc! { "_id": movie_oid, "collectionId": coll_oid, "ownerId": owner_id };

        // Preserve the original creation timestamp across edits (009 #5) — read it
        // before the full-document replace so it is not reset to "now".
        let existing = self
            .collection
            .find_one(filter.clone())
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
            .ok_or(DomainError::MovieNotFound)?;
        let created_at = existing.created_at;

        let replacement = MovieDao {
            id: Some(movie_oid),
            collection_id: coll_oid,
            owner_id: owner_id.to_string(),
            title: dto.title,
            year: dto.year,
            content_type: content_type_to_str(&dto.content_type).to_string(),
            language: dto.language,
            owned: dto.owned,
            ripped: dto.ripped,
            childrens: dto.childrens,
            original_title: dto.original_title,
            release_date: dto.release_date,
            outline: dto.outline,
            plot: dto.plot,
            runtime: dto.runtime,
            rated: dto.rated.as_ref().map(|r| rating_to_str(r).to_string()),
            directors: dto.directors,
            actors: dto.actors,
            movie_set: dto.movie_set,
            tags: dto.tags,
            genres: dto.genres,
            owned_media: dto
                .owned_media
                .iter()
                .map(|m| media_format_to_str(m).to_string())
                .collect(),
            rip_quality: dto
                .rip_quality
                .iter()
                .map(|m| media_format_to_str(m).to_string())
                .collect(),
            external_ids: dto
                .external_ids
                .iter()
                .map(|e| ExternalIdDao {
                    system: e.system.clone(),
                    unique_id: e.unique_id.clone(),
                    url: e.url.clone(),
                })
                .collect(),
            created_at, // preserved from the existing document (009 #5)
            updated_at: DateTime::now(),
        };

        let result = self
            .collection
            .replace_one(filter, replacement)
            .await
            .map_err(|e| {
                if is_duplicate_key(&e) {
                    DomainError::DuplicateMovie
                } else {
                    DomainError::Internal(e.to_string())
                }
            })?;

        if result.matched_count == 0 {
            return Err(DomainError::MovieNotFound);
        }

        self.get_by_id(collection_id, movie_id, owner_id).await
    }

    async fn delete(
        &self,
        collection_id: &str,
        movie_id: &str,
        owner_id: &str,
    ) -> Result<(), DomainError> {
        let coll_oid = parse_coll_oid(collection_id)?;
        let movie_oid = parse_oid(movie_id)?;
        let filter = doc! { "_id": movie_oid, "collectionId": coll_oid, "ownerId": owner_id };
        let result = self
            .collection
            .delete_one(filter)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?;

        if result.deleted_count == 0 {
            return Err(DomainError::MovieNotFound);
        }
        Ok(())
    }

    async fn list(
        &self,
        collection_id: &str,
        owner_id: &str,
        params: ListMoviesParams,
    ) -> Result<MovieListDto, DomainError> {
        use futures::TryStreamExt;

        let coll_oid = parse_coll_oid(collection_id)?;
        let mut filter = doc! { "collectionId": coll_oid, "ownerId": owner_id };

        // Cursor-based pagination. A malformed/undecodable cursor is rejected with
        // a 400 rather than silently restarting at page 1 (009 FR-019).
        if let Some(ref cursor_str) = params.cursor {
            match decode_cursor(cursor_str) {
                Some(last_id) => {
                    filter.insert("_id", doc! { "$gt": last_id });
                }
                None => {
                    return Err(DomainError::ValidationError(
                        "Invalid pagination cursor".to_string(),
                    ));
                }
            }
        }

        // Substring search across all indexed text fields.
        //
        // We use $regex (case-insensitive) instead of $text so that partial-word
        // and substring queries work as users expect (e.g. "Spiel" matches
        // "Steven Spielberg").  $text only does whole-word tokenised matching, which
        // is surprising for a personal collection search bar.  At the scale of a
        // personal collection $regex is fast enough.
        if let Some(ref search) = params.search {
            let pattern = escape_for_regex(search);
            let make_re = || bson::Regex {
                pattern: pattern.clone(),
                options: "i".to_string(),
            };
            filter.insert(
                "$or",
                bson::Bson::Array(vec![
                    doc! { "title":         { "$regex": make_re() } }.into(),
                    doc! { "originalTitle": { "$regex": make_re() } }.into(),
                    doc! { "directors":     { "$regex": make_re() } }.into(),
                    doc! { "actors":        { "$regex": make_re() } }.into(),
                    doc! { "movieSet":      { "$regex": make_re() } }.into(),
                    doc! { "tags":          { "$regex": make_re() } }.into(),
                    doc! { "outline":       { "$regex": make_re() } }.into(),
                    doc! { "plot":          { "$regex": make_re() } }.into(),
                ]),
            );
        }

        // Filters
        if let Some(ref ct) = params.content_type {
            filter.insert("contentType", ct.as_str());
        }
        if !params.genres.is_empty() {
            filter.insert("genres", doc! { "$in": &params.genres });
        }
        if let Some(childrens) = params.childrens {
            filter.insert("childrens", childrens);
        }
        if let Some(ref rated) = params.rated {
            filter.insert("rated", rated.as_str());
        }
        if let Some(ref lang) = params.language {
            filter.insert("language", lang.as_str());
        }
        if let Some(decade) = params.decade {
            filter.insert("year", doc! { "$gte": decade, "$lte": decade + 9 });
        }
        if let Some(owned) = params.owned {
            filter.insert("owned", owned);
        }
        if !params.owned_media.is_empty() {
            filter.insert("ownedMedia", doc! { "$in": &params.owned_media });
        }
        if let Some(ripped) = params.ripped {
            filter.insert("ripped", ripped);
        }
        if !params.rip_quality.is_empty() {
            filter.insert("ripQuality", doc! { "$in": &params.rip_quality });
        }

        let batch_size = 50u32;
        let find_opts = mongodb::options::FindOptions::builder()
            .limit(batch_size as i64 + 1) // fetch one extra to determine if there's a next page
            .sort(doc! { "_id": 1 })
            .build();

        let mut cursor = self
            .collection
            .find(filter)
            .with_options(find_opts)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?;

        let mut items = Vec::new();
        while let Some(dao) = cursor
            .try_next()
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
        {
            items.push(dao);
            if items.len() as u32 > batch_size {
                break;
            }
        }

        let has_more = items.len() as u32 > batch_size;
        if has_more {
            items.pop();
        }

        let next_cursor = if has_more {
            items
                .last()
                .and_then(|dao| dao.id.as_ref())
                .map(encode_cursor)
        } else {
            None
        };

        Ok(MovieListDto {
            items: items.into_iter().map(dao_to_dto).collect(),
            next_cursor,
        })
    }

    async fn count(
        &self,
        collection_id: &str,
        owner_id: &str,
        params: ListMoviesParams,
    ) -> Result<u64, DomainError> {
        // Same filter as `list` (the shared `build_movie_filter`), counted server-side via
        // `count_documents` — no document fetch, index-backed (US4 / FR-023).
        let coll_oid = parse_coll_oid(collection_id)?;
        let filter = build_movie_filter(coll_oid, owner_id, &params);
        self.collection
            .count_documents(filter)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))
    }

    async fn get_filter_options(
        &self,
        collection_id: &str,
        owner_id: &str,
    ) -> Result<FilterOptionsDto, DomainError> {
        let coll_oid = parse_coll_oid(collection_id)?;
        let filter = doc! { "collectionId": coll_oid, "ownerId": owner_id };

        let genres = self
            .collection
            .distinct("genres", filter.clone())
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();

        let content_types_raw: Vec<String> = self
            .collection
            .distinct("contentType", filter.clone())
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();

        let content_types = content_types_raw
            .iter()
            .filter_map(|s| match s.as_str() {
                "Series" => Some(ContentType::Series),
                "Concert" => Some(ContentType::Concert),
                "Movie" => Some(ContentType::Movie),
                _ => None,
            })
            .collect();

        let rated = self
            .collection
            .distinct("rated", filter.clone())
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();

        let languages = self
            .collection
            .distinct("language", filter.clone())
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();

        let years: Vec<i32> = self
            .collection
            .distinct("year", filter.clone())
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
            .into_iter()
            .filter_map(|v| v.as_i32())
            .collect();

        let mut decades: Vec<i32> = years.iter().map(|&y| (y / 10) * 10).collect();
        decades.sort();
        decades.dedup();

        let owned_media = self
            .collection
            .distinct("ownedMedia", filter.clone())
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();

        let rip_quality = self
            .collection
            .distinct("ripQuality", filter)
            .await
            .map_err(|e| DomainError::Internal(e.to_string()))?
            .into_iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();

        Ok(FilterOptionsDto {
            genres,
            content_types,
            rated,
            languages,
            decades,
            owned_media,
            rip_quality,
        })
    }
}
