/// T085 — Movie adapter integration tests: create + required fields + duplicate rejection
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
    String,
    mongodb::Database,
) {
    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");

    let coll_repo = MongoCollectionRepository::new(&db);
    let movie_repo = MongoMovieRepository::new(&db);

    // Create a collection to hold movies in tests
    let coll = coll_repo
        .create(
            "movie-owner",
            CreateCollectionDto {
                name: "Test Collection".to_string(),
                description: None,
            },
        )
        .await
        .expect("test collection create failed");

    (coll_repo, movie_repo, coll.id, db)
}

fn sample_movie_dto() -> CreateMovieDto {
    CreateMovieDto {
        title: "Fight Club".to_string(),
        year: 1999,
        content_type: ContentType::Movie,
        language: "English".to_string(),
        owned: true,
        ripped: true,
        childrens: false,
        owned_media: vec![MediaFormat::BluRay],
        rip_quality: vec![MediaFormat::BluRay],
        genres: vec!["Drama".to_string(), "Thriller".to_string()],
        rated: Some(UsaRating::R),
        directors: vec!["David Fincher".to_string()],
        actors: vec!["Brad Pitt".to_string(), "Edward Norton".to_string()],
        tags: vec![],
        movie_set: None,
        original_title: None,
        release_date: Some("1999-10-15".to_string()),
        outline: None,
        plot: None,
        runtime: Some(139),
        external_ids: vec![],
    }
}

#[tokio::test]
async fn create_returns_dto_with_generated_id() {
    let (_, movie_repo, coll_id, db) = repos().await;

    let result = movie_repo
        .create(&coll_id, "movie-owner", sample_movie_dto())
        .await;
    crate::common::cleanup_db(&db).await;

    let movie = result.expect("create should succeed");
    assert!(!movie.id.is_empty(), "movie id must be set");
    assert_eq!(movie.title, "Fight Club");
    assert_eq!(movie.year, 1999);
    assert_eq!(movie.collection_id, coll_id);
}

#[tokio::test]
async fn create_rejects_duplicate_title_year_content_type() {
    let (_, movie_repo, coll_id, db) = repos().await;

    movie_repo
        .create(&coll_id, "movie-owner", sample_movie_dto())
        .await
        .expect("first create should succeed");

    let result = movie_repo
        .create(&coll_id, "movie-owner", sample_movie_dto())
        .await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::DuplicateMovie)),
        "duplicate title+year+contentType in same collection must return DuplicateMovie"
    );
}

/// NOTE: `OwnedMediaWhenNotOwned` is enforced by `CreateMovieHandler` (application layer),
/// NOT by `MongoMovieRepository` (adapter layer). The adapter persists whatever DTO it
/// receives; validation is the handler's responsibility.
///
/// Clean Architecture: business rules live in Application, not Adapters.
/// This spec is tested at the correct layer in:
///   - `http_create_update_test::create_movie_owned_media_when_not_owned_returns_domain_error`
///   - `application::commands::create_movie::tests::*` (unit tests)
#[tokio::test]
#[ignore = "OwnedMediaWhenNotOwned is enforced in CreateMovieHandler (application layer), not the adapter; verified in http_create_update_test.rs"]
async fn create_rejects_owned_media_when_not_owned() {
    let (_, movie_repo, coll_id, db) = repos().await;

    let mut dto = sample_movie_dto();
    dto.title = "Not Owned".to_string();
    dto.owned = false;
    dto.owned_media = vec![MediaFormat::Dvd]; // adapter accepts this; handler rejects it

    let result = movie_repo.create(&coll_id, "movie-owner", dto).await;
    crate::common::cleanup_db(&db).await;

    // Adapter does not enforce this spec — this assertion would fail
    assert!(
        matches!(result, Err(DomainError::OwnedMediaWhenNotOwned)),
        "ownedMedia with owned=false must return OwnedMediaWhenNotOwned"
    );
}

/// NOTE: `RipQualityWhenNotRipped` is enforced by `CreateMovieHandler` (application layer),
/// NOT by `MongoMovieRepository` (adapter layer).
///
/// See `http_create_update_test::create_movie_rip_quality_when_not_ripped_returns_domain_error`.
#[tokio::test]
#[ignore = "RipQualityWhenNotRipped is enforced in CreateMovieHandler (application layer), not the adapter; verified in http_create_update_test.rs"]
async fn create_rejects_rip_quality_when_not_ripped() {
    let (_, movie_repo, coll_id, db) = repos().await;

    let mut dto = sample_movie_dto();
    dto.title = "Not Ripped".to_string();
    dto.ripped = false;
    dto.rip_quality = vec![MediaFormat::BluRay]; // adapter accepts this; handler rejects it

    let result = movie_repo.create(&coll_id, "movie-owner", dto).await;
    crate::common::cleanup_db(&db).await;

    // Adapter does not enforce this spec — this assertion would fail
    assert!(
        matches!(result, Err(DomainError::RipQualityWhenNotRipped)),
        "ripQuality with ripped=false must return RipQualityWhenNotRipped"
    );
}
