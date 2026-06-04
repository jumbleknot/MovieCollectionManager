//! DAC authorization integration tests (011 clean-dac, US1/US2/US3).
//!
//! Real MongoDB (no mocking — constitution v1.3.0). Exercises movie handlers
//! end-to-end through the access-control seam: cross-tenant writes/reads are
//! denied with CollectionNotFound (404, no existence leak); the collection owner
//! retains full CRUD; seeded contributor/viewer ACL entries are authorized to
//! exactly their level (SC-006); and every write stamps ownerId = collection owner.

use std::sync::Arc;

use bson::{doc, oid::ObjectId};
use mongodb::Database;

use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
use mc_service::application::commands::create_movie::{CreateMovieCommand, CreateMovieHandler};
use mc_service::application::commands::delete_movie::{DeleteMovieCommand, DeleteMovieHandler};
use mc_service::application::commands::update_movie::{UpdateMovieCommand, UpdateMovieHandler};
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::dtos::movie_dto::{CreateMovieDto, UpdateMovieDto};
use mc_service::application::ports::collection_repository::CollectionRepository;
use mc_service::application::ports::movie_repository::{ListMoviesParams, MovieRepository};
use mc_service::application::queries::list_movies::{ListMoviesHandler, ListMoviesQuery};
use mc_service::domain::errors::DomainError;
use mc_service::domain::movie::ContentType;

const OWNER_A: &str = "owner-a";
const USER_B: &str = "user-b";

struct Ctx {
    movie_repo: Arc<dyn MovieRepository>,
    coll_repo: Arc<dyn CollectionRepository>,
    coll_id: String,
    db: Database,
}

async fn setup() -> Ctx {
    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");

    let coll_repo: Arc<dyn CollectionRepository> = Arc::new(MongoCollectionRepository::new(&db));
    let movie_repo: Arc<dyn MovieRepository> = Arc::new(MongoMovieRepository::new(&db));

    let coll = coll_repo
        .create(
            OWNER_A,
            CreateCollectionDto {
                name: "A's Collection".to_string(),
                description: None,
            },
        )
        .await
        .expect("collection create failed");

    Ctx {
        movie_repo,
        coll_repo,
        coll_id: coll.id,
        db,
    }
}

fn create_dto(title: &str) -> CreateMovieDto {
    CreateMovieDto {
        title: title.to_string(),
        year: 2010,
        content_type: ContentType::Movie,
        language: "English".to_string(),
        owned: false,
        ripped: false,
        childrens: false,
        owned_media: vec![],
        rip_quality: vec![],
        genres: vec![],
        rated: None,
        directors: vec![],
        actors: vec![],
        tags: vec![],
        movie_set: None,
        original_title: None,
        release_date: None,
        outline: None,
        plot: None,
        runtime: None,
        external_ids: vec![],
    }
}

fn update_dto(title: &str) -> UpdateMovieDto {
    UpdateMovieDto {
        title: title.to_string(),
        year: 2011,
        content_type: ContentType::Movie,
        language: "English".to_string(),
        owned: false,
        ripped: false,
        childrens: false,
        owned_media: vec![],
        rip_quality: vec![],
        genres: vec![],
        rated: None,
        directors: vec![],
        actors: vec![],
        tags: vec![],
        movie_set: None,
        original_title: None,
        release_date: None,
        outline: None,
        plot: None,
        runtime: None,
        external_ids: vec![],
    }
}

/// Seed an ACL entry directly into the collection document (granting endpoints are
/// out of scope; this exercises the enforcement seam — SC-006).
async fn grant(db: &Database, coll_id: &str, user: &str, role: &str) {
    db.collection::<bson::Document>("movie_collections")
        .update_one(
            doc! { "_id": ObjectId::parse_str(coll_id).unwrap() },
            doc! { "$push": { "acl": { "userId": user, "role": role } } },
        )
        .await
        .expect("acl seed failed");
}

/// Read the stored `ownerId` of a movie directly from MongoDB.
async fn stored_owner(db: &Database, movie_id: &str) -> String {
    db.collection::<bson::Document>("movies")
        .find_one(doc! { "_id": ObjectId::parse_str(movie_id).unwrap() })
        .await
        .expect("query failed")
        .expect("movie not found")
        .get_str("ownerId")
        .expect("ownerId missing")
        .to_string()
}

async fn movie_count(db: &Database, coll_id: &str) -> u64 {
    db.collection::<bson::Document>("movies")
        .count_documents(doc! { "collectionId": ObjectId::parse_str(coll_id).unwrap() })
        .await
        .expect("count failed")
}

// ─── US1: write authorization ────────────────────────────────────────────────

#[tokio::test]
async fn unauthorized_user_cannot_create_movie() {
    let ctx = setup().await;
    let handler = CreateMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));

    let result = handler
        .handle(CreateMovieCommand {
            collection_id: ctx.coll_id.clone(),
            owner_id: USER_B.to_string(),
            dto: create_dto("Intruder Movie"),
        })
        .await;

    let count = movie_count(&ctx.db, &ctx.coll_id).await;
    crate::common::cleanup_db(&ctx.db).await;

    assert!(
        matches!(result, Err(DomainError::CollectionNotFound)),
        "unauthorized create must be CollectionNotFound (404), got {result:?}"
    );
    assert_eq!(
        count, 0,
        "no movie may be written on an unauthorized create"
    );
}

#[tokio::test]
async fn write_to_nonexistent_collection_is_not_found() {
    let ctx = setup().await;
    let handler = CreateMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));

    let result = handler
        .handle(CreateMovieCommand {
            collection_id: ObjectId::new().to_hex(), // valid-format, nonexistent
            owner_id: OWNER_A.to_string(),
            dto: create_dto("Ghost"),
        })
        .await;
    crate::common::cleanup_db(&ctx.db).await;

    assert!(
        matches!(result, Err(DomainError::CollectionNotFound)),
        "write to a nonexistent collection must be CollectionNotFound, got {result:?}"
    );
}

#[tokio::test]
async fn unauthorized_user_cannot_update_or_delete_movie() {
    let ctx = setup().await;
    let create = CreateMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));
    let movie = create
        .handle(CreateMovieCommand {
            collection_id: ctx.coll_id.clone(),
            owner_id: OWNER_A.to_string(),
            dto: create_dto("A's Movie"),
        })
        .await
        .expect("owner create should succeed");

    let update = UpdateMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));
    let upd = update
        .handle(UpdateMovieCommand {
            collection_id: ctx.coll_id.clone(),
            movie_id: movie.id.clone(),
            owner_id: USER_B.to_string(),
            dto: update_dto("Hacked"),
        })
        .await;

    let delete = DeleteMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));
    let del = delete
        .handle(DeleteMovieCommand {
            collection_id: ctx.coll_id.clone(),
            movie_id: movie.id.clone(),
            owner_id: USER_B.to_string(),
        })
        .await;

    let count = movie_count(&ctx.db, &ctx.coll_id).await;
    crate::common::cleanup_db(&ctx.db).await;

    assert!(
        matches!(upd, Err(DomainError::CollectionNotFound)),
        "unauthorized update → 404"
    );
    assert!(
        matches!(del, Err(DomainError::CollectionNotFound)),
        "unauthorized delete → 404"
    );
    assert_eq!(
        count, 1,
        "the movie must be unchanged after unauthorized update/delete"
    );
}

#[tokio::test]
async fn owner_retains_full_write_access() {
    let ctx = setup().await;
    let create = CreateMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));

    let movie = create
        .handle(CreateMovieCommand {
            collection_id: ctx.coll_id.clone(),
            owner_id: OWNER_A.to_string(),
            dto: create_dto("Owner Movie"),
        })
        .await
        .expect("owner create should succeed");

    // Duplicate (same title/year/contentType) still rejected — uniqueness unchanged (FR-007).
    let dup = create
        .handle(CreateMovieCommand {
            collection_id: ctx.coll_id.clone(),
            owner_id: OWNER_A.to_string(),
            dto: create_dto("Owner Movie"),
        })
        .await;

    let delete = DeleteMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));
    let del = delete
        .handle(DeleteMovieCommand {
            collection_id: ctx.coll_id.clone(),
            movie_id: movie.id.clone(),
            owner_id: OWNER_A.to_string(),
        })
        .await;
    crate::common::cleanup_db(&ctx.db).await;

    assert!(
        matches!(dup, Err(DomainError::DuplicateMovie)),
        "duplicate still rejected"
    );
    assert!(del.is_ok(), "owner delete should succeed");
}

// ─── US2: read authorization ─────────────────────────────────────────────────

#[tokio::test]
async fn unauthorized_user_cannot_list_movies() {
    let ctx = setup().await;
    let create = CreateMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));
    create
        .handle(CreateMovieCommand {
            collection_id: ctx.coll_id.clone(),
            owner_id: OWNER_A.to_string(),
            dto: create_dto("A's Movie"),
        })
        .await
        .expect("owner create should succeed");

    let list = ListMoviesHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));
    let result = list
        .handle(ListMoviesQuery {
            collection_id: ctx.coll_id.clone(),
            owner_id: USER_B.to_string(),
            params: ListMoviesParams::default(),
        })
        .await;
    crate::common::cleanup_db(&ctx.db).await;

    assert!(
        matches!(result, Err(DomainError::CollectionNotFound)),
        "unauthorized list must be CollectionNotFound, got {result:?}"
    );
}

#[tokio::test]
async fn seeded_viewer_can_read_but_not_write() {
    let ctx = setup().await;
    let create = CreateMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));
    create
        .handle(CreateMovieCommand {
            collection_id: ctx.coll_id.clone(),
            owner_id: OWNER_A.to_string(),
            dto: create_dto("Shared Movie"),
        })
        .await
        .expect("owner create should succeed");

    grant(&ctx.db, &ctx.coll_id, USER_B, "viewer").await;

    // Viewer can read.
    let list = ListMoviesHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));
    let read = list
        .handle(ListMoviesQuery {
            collection_id: ctx.coll_id.clone(),
            owner_id: USER_B.to_string(),
            params: ListMoviesParams::default(),
        })
        .await
        .expect("seeded viewer should read");

    // Viewer cannot write (viewer < contributor).
    let create_b = CreateMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));
    let write = create_b
        .handle(CreateMovieCommand {
            collection_id: ctx.coll_id.clone(),
            owner_id: USER_B.to_string(),
            dto: create_dto("Viewer Write Attempt"),
        })
        .await;
    crate::common::cleanup_db(&ctx.db).await;

    assert_eq!(
        read.items.len(),
        1,
        "seeded viewer sees the collection's movies"
    );
    assert!(
        matches!(write, Err(DomainError::CollectionNotFound)),
        "viewer must not be able to write, got {write:?}"
    );
}

// ─── US3: owner reference = collection owner ─────────────────────────────────

#[tokio::test]
async fn owner_reference_is_collection_owner_on_owner_write() {
    let ctx = setup().await;
    let create = CreateMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));
    let movie = create
        .handle(CreateMovieCommand {
            collection_id: ctx.coll_id.clone(),
            owner_id: OWNER_A.to_string(),
            dto: create_dto("Owner Movie"),
        })
        .await
        .expect("owner create should succeed");

    let owner = stored_owner(&ctx.db, &movie.id).await;
    crate::common::cleanup_db(&ctx.db).await;
    assert_eq!(owner, OWNER_A, "ownerId must equal the collection owner");
}

#[tokio::test]
async fn seeded_contributor_write_stamps_collection_owner_not_contributor() {
    let ctx = setup().await;
    grant(&ctx.db, &ctx.coll_id, USER_B, "contributor").await;

    let create = CreateMovieHandler::new(Arc::clone(&ctx.movie_repo), Arc::clone(&ctx.coll_repo));
    let movie = create
        .handle(CreateMovieCommand {
            collection_id: ctx.coll_id.clone(),
            owner_id: USER_B.to_string(), // contributor performs the write
            dto: create_dto("Contributor Movie"),
        })
        .await
        .expect("seeded contributor should be able to create");

    let owner = stored_owner(&ctx.db, &movie.id).await;
    crate::common::cleanup_db(&ctx.db).await;
    assert_eq!(
        owner, OWNER_A,
        "ownerId must be the collection owner (A), not the acting contributor (B)"
    );
}
