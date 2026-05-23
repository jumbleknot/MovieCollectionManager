/// T039 — Adapter integration tests: delete collection + cascade movies
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

    let movie_dto = CreateMovieDto {
        title: "The Matrix".to_string(),
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
        directors: vec!["Wachowski".to_string()],
        actors: vec![],
        tags: vec![],
        movie_set: None,
        original_title: None,
        release_date: None,
        outline: None,
        plot: None,
        runtime: Some(136),
        external_ids: vec![],
    };
    let movie = movie_repo
        .create(&coll.id, "owner-cascade", movie_dto)
        .await
        .expect("movie create failed");

    coll_repo
        .delete(&coll.id, "owner-cascade")
        .await
        .expect("delete failed");

    let movie_result = movie_repo
        .get_by_id(&coll.id, &movie.id, "owner-cascade")
        .await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(
            movie_result,
            Err(DomainError::MovieNotFound) | Err(DomainError::CollectionNotFound)
        ),
        "movies must be deleted when their collection is deleted"
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
