/// T039 — Adapter integration tests: delete collection + cascade movies
/// T166 — Strengthened tests: 3-movie cascade, atomicity verification
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::dtos::movie_dto::CreateMovieDto;
use mc_service::application::ports::collection_repository::CollectionRepository;
use mc_service::application::ports::movie_repository::MovieRepository;
use mc_service::domain::errors::DomainError;
use mc_service::domain::movie::{ContentType, MediaFormat, UsaRating};

async fn repos() -> (
    MongoCollectionRepository,
    MongoMovieRepository,
    mongodb::Database,
) {
    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");
    (
        MongoCollectionRepository::new(&db),
        MongoMovieRepository::new(&db),
        db,
    )
}

fn make_movie_dto(title: &str) -> CreateMovieDto {
    CreateMovieDto {
        title: title.to_string(),
        year: 1999,
        content_type: ContentType::Movie,
        language: "English".to_string(),
        owned: true,
        ripped: false,
        childrens: false,
        owned_media: vec![MediaFormat::BluRay],
        rip_quality: vec![],
        genres: vec!["Sci-Fi".to_string()],
        rated: Some(UsaRating::R),
        directors: vec!["Director".to_string()],
        actors: vec![],
        tags: vec![],
        movie_set: None,
        original_title: None,
        release_date: None,
        outline: None,
        plot: None,
        runtime: Some(120),
        external_ids: vec![],
    }
}

#[tokio::test]
async fn delete_removes_collection() {
    let (coll_repo, _movie_repo, db) = repos().await;

    let created = coll_repo
        .create(
            "owner-del",
            CreateCollectionDto {
                name: "To Delete".to_string(),
                description: None,
            },
        )
        .await
        .expect("create failed");

    let del_result = coll_repo.delete(&created.id, "owner-del").await;
    let get_result = coll_repo.get_by_id(&created.id, "owner-del").await;
    crate::common::cleanup_db(&db).await;

    del_result.expect("delete should succeed");
    assert!(
        matches!(get_result, Err(DomainError::CollectionNotFound)),
        "collection must not be found after deletion"
    );
}

/// T166: Seed 3 movies, delete the collection, assert ALL movies are gone.
/// Verifies the cascade operates on every movie, not just the first one.
#[tokio::test]
async fn delete_cascades_to_movies() {
    let (coll_repo, movie_repo, db) = repos().await;

    let coll = coll_repo
        .create(
            "owner-cascade",
            CreateCollectionDto {
                name: "With Movies".to_string(),
                description: None,
            },
        )
        .await
        .expect("create collection failed");

    // Seed 3 movies to verify the cascade deletes ALL of them, not just one.
    for title in [
        "The Matrix",
        "The Matrix Reloaded",
        "The Matrix Revolutions",
    ] {
        movie_repo
            .create(&coll.id, "owner-cascade", make_movie_dto(title))
            .await
            .expect("movie create failed");
    }

    // Verify 3 movies are present before delete
    let movies_before = movie_repo
        .list(
            &coll.id,
            "owner-cascade",
            mc_service::application::ports::movie_repository::ListMoviesParams::default(),
        )
        .await
        .expect("list before delete failed");
    assert_eq!(
        movies_before.items.len(),
        3,
        "expected 3 movies before delete"
    );

    coll_repo
        .delete(&coll.id, "owner-cascade")
        .await
        .expect("delete failed");

    // Count movie documents directly to confirm ALL were removed (not just
    // those visible through the repository's ownership filter).
    let movies_col: mongodb::Collection<bson::Document> = db.collection("movies");
    let coll_oid = bson::oid::ObjectId::parse_str(&coll.id).expect("parse coll id");
    let remaining = movies_col
        .count_documents(bson::doc! { "collectionId": coll_oid })
        .await
        .expect("count failed");
    crate::common::cleanup_db(&db).await;

    assert_eq!(
        remaining, 0,
        "all movies must be deleted when their collection is deleted"
    );
}

/// T166: Verify atomicity via the ownership guard.
/// When delete is rejected (wrong owner), no movies are touched — the
/// transaction aborts before any cascading occurs.
#[tokio::test]
async fn delete_is_atomic_on_cascade_failure() {
    let (coll_repo, movie_repo, db) = repos().await;

    let coll = coll_repo
        .create(
            "real-owner",
            CreateCollectionDto {
                name: "Protected Collection".to_string(),
                description: None,
            },
        )
        .await
        .expect("create failed");

    // Seed 3 movies
    for title in ["Movie A", "Movie B", "Movie C"] {
        movie_repo
            .create(&coll.id, "real-owner", make_movie_dto(title))
            .await
            .expect("movie create failed");
    }

    // Attempt delete with wrong owner — must fail and leave movies intact.
    let result = coll_repo.delete(&coll.id, "attacker").await;
    assert!(
        matches!(result, Err(DomainError::CollectionNotFound)),
        "wrong owner must return CollectionNotFound"
    );

    // Verify all 3 movies survived the failed delete attempt.
    let movies_col: mongodb::Collection<bson::Document> = db.collection("movies");
    let coll_oid = bson::oid::ObjectId::parse_str(&coll.id).expect("parse coll id");
    let surviving = movies_col
        .count_documents(bson::doc! { "collectionId": coll_oid })
        .await
        .expect("count failed");

    // Now delete legitimately and verify cascade.
    coll_repo
        .delete(&coll.id, "real-owner")
        .await
        .expect("legitimate delete failed");
    let after_real_delete = movies_col
        .count_documents(bson::doc! { "collectionId": coll_oid })
        .await
        .expect("count after real delete failed");
    crate::common::cleanup_db(&db).await;

    assert_eq!(
        surviving, 3,
        "failed delete must not remove any movies (atomicity)"
    );
    assert_eq!(
        after_real_delete, 0,
        "legitimate delete must cascade to all movies"
    );
}

#[tokio::test]
async fn delete_returns_not_found_for_wrong_owner() {
    let (coll_repo, _movie_repo, db) = repos().await;

    let created = coll_repo
        .create(
            "real-owner-del",
            CreateCollectionDto {
                name: "Sensitive".to_string(),
                description: None,
            },
        )
        .await
        .expect("create failed");

    let result = coll_repo.delete(&created.id, "attacker").await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::CollectionNotFound)),
        "wrong owner must return CollectionNotFound on delete"
    );
}
