/// T088 — HTTP integration tests for movie create, get, and update endpoints.
///
/// Tests the full HTTP layer (Axum router → handler → application → repository).
///
/// Authenticated-path tests (201 happy path, 400 OWNED_MEDIA_WHEN_NOT_OWNED,
/// 400 RIP_QUALITY_WHEN_NOT_RIPPED, 409 DUPLICATE_MOVIE, 404 COLLECTION_NOT_FOUND,
/// 404 MOVIE_NOT_FOUND) require a valid Keycloak JWT and are marked `#[ignore]` —
/// they are covered during full-stack E2E testing (T107).
///
/// Unauthenticated 401 tests are also marked `#[ignore]` due to
/// axum-keycloak-auth JWKS timing issues in sequential test runs.
///
/// Domain validation and error propagation are verified at the application/adapter
/// layer below — these tests do NOT require Keycloak or `#[ignore]`.
///
/// Run (with all services running):
///   pnpm nx test:integration mc-service -- --test movies_test
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use tower::ServiceExt;

async fn build_test_app() -> axum::Router {
    let db = crate::common::test_db().await;
    let config = mc_service::config::Config::from_env()
        .expect("Missing test config — ensure backend/mc-service/.env.local exists");
    mc_service::api::router::build(db, &config)
        .await
        .expect("Router build failed")
}

// ── POST /api/v1/collections/:id/movies ─────────────────────────────────────

/// POST /movies without a JWT returns 401.
#[tokio::test]
#[ignore = "requires full-stack (Keycloak + axum-keycloak-auth JWKS timing); verified in E2E"]
async fn create_movie_returns_401_without_jwt() {
    let app = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/collections/65b1234567890abcdef01234/movies")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"title":"Test","year":2020,"contentType":"Movie","language":"English","owned":false,"ripped":false,"childrens":false,"directors":[],"actors":[],"genres":[],"tags":[],"ownedMedia":[],"ripQuality":[],"externalIds":[]}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "POST /movies without JWT must return 401"
    );
}

// ── GET /api/v1/collections/:id/movies/:movieId ─────────────────────────────

/// GET /movies/:movieId without a JWT returns 401.
#[tokio::test]
#[ignore = "requires full-stack (Keycloak + axum-keycloak-auth JWKS timing); verified in E2E"]
async fn get_movie_returns_401_without_jwt() {
    let app = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/v1/collections/65b1234567890abcdef01234/movies/65b1234567890abcdef09999")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "GET /movies/:movieId without JWT must return 401"
    );
}

// ── PUT /api/v1/collections/:id/movies/:movieId ─────────────────────────────

/// PUT /movies/:movieId without a JWT returns 401.
#[tokio::test]
#[ignore = "requires full-stack (Keycloak + axum-keycloak-auth JWKS timing); verified in E2E"]
async fn update_movie_returns_401_without_jwt() {
    let app = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("PUT")
                .uri("/api/v1/collections/65b1234567890abcdef01234/movies/65b1234567890abcdef09999")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"title":"Updated","year":2021,"contentType":"Movie","language":"English","owned":false,"ripped":false,"childrens":false,"directors":[],"actors":[],"genres":[],"tags":[],"ownedMedia":[],"ripQuality":[],"externalIds":[]}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "PUT /movies/:movieId without JWT must return 401"
    );
}

// ── Domain validation — application layer (no JWT needed) ────────────────────

/// OwnedMediaWhenNotOwned: owned=false + owned_media set → ValidationError.
///
/// Verifies the domain spec `OwnedMediaWhenNotOwnedSpec` enforced in CreateMovieHandler.
/// Maps to HTTP 400 OWNED_MEDIA_WHEN_NOT_OWNED.
#[tokio::test]
async fn create_movie_owned_media_when_not_owned_returns_domain_error() {
    use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
    use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
    use mc_service::application::commands::create_movie::{CreateMovieCommand, CreateMovieHandler};
    use mc_service::application::dtos::collection_dto::CreateCollectionDto;
    use mc_service::application::dtos::movie_dto::CreateMovieDto;
    use mc_service::application::ports::collection_repository::CollectionRepository;
    use mc_service::application::ports::movie_repository::MovieRepository;
    use mc_service::domain::errors::DomainError;
    use mc_service::domain::movie::{ContentType, MediaFormat};
    use std::sync::Arc;

    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");

    let coll_repo: Arc<dyn CollectionRepository> =
        Arc::new(MongoCollectionRepository::new(&db)) as Arc<dyn CollectionRepository>;
    let movie_repo: Arc<dyn MovieRepository> =
        Arc::new(MongoMovieRepository::new(&db)) as Arc<dyn MovieRepository>;

    let coll = coll_repo
        .create(
            "media-spec-owner",
            CreateCollectionDto {
                name: "Media Spec Test".to_string(),
                description: None,
            },
        )
        .await
        .expect("create collection failed");

    let handler = CreateMovieHandler::new(movie_repo);
    let result = handler
        .handle(CreateMovieCommand {
            collection_id: coll.id.clone(),
            owner_id: "media-spec-owner".to_string(),
            dto: CreateMovieDto {
                title: "Not Owned With Media".to_string(),
                year: 2020,
                content_type: ContentType::Movie,
                language: "English".to_string(),
                owned: false, // not owned
                ripped: false,
                childrens: false,
                owned_media: vec![MediaFormat::BluRay], // but media specified — invalid
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
            },
        })
        .await;

    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::OwnedMediaWhenNotOwned)),
        "owned=false + owned_media set must return OwnedMediaWhenNotOwned (HTTP 400) — got: {result:?}"
    );
}

/// RipQualityWhenNotRipped: ripped=false + rip_quality set → ValidationError.
///
/// Verifies the domain spec `RipQualityWhenNotRippedSpec` enforced in CreateMovieHandler.
/// Maps to HTTP 400 RIP_QUALITY_WHEN_NOT_RIPPED.
#[tokio::test]
async fn create_movie_rip_quality_when_not_ripped_returns_domain_error() {
    use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
    use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
    use mc_service::application::commands::create_movie::{CreateMovieCommand, CreateMovieHandler};
    use mc_service::application::dtos::collection_dto::CreateCollectionDto;
    use mc_service::application::dtos::movie_dto::CreateMovieDto;
    use mc_service::application::ports::collection_repository::CollectionRepository;
    use mc_service::application::ports::movie_repository::MovieRepository;
    use mc_service::domain::errors::DomainError;
    use mc_service::domain::movie::{ContentType, MediaFormat};
    use std::sync::Arc;

    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");

    let coll_repo: Arc<dyn CollectionRepository> =
        Arc::new(MongoCollectionRepository::new(&db)) as Arc<dyn CollectionRepository>;
    let movie_repo: Arc<dyn MovieRepository> =
        Arc::new(MongoMovieRepository::new(&db)) as Arc<dyn MovieRepository>;

    let coll = coll_repo
        .create(
            "rip-spec-owner",
            CreateCollectionDto {
                name: "Rip Spec Test".to_string(),
                description: None,
            },
        )
        .await
        .expect("create collection failed");

    let handler = CreateMovieHandler::new(movie_repo);
    let result = handler
        .handle(CreateMovieCommand {
            collection_id: coll.id.clone(),
            owner_id: "rip-spec-owner".to_string(),
            dto: CreateMovieDto {
                title: "Not Ripped With Quality".to_string(),
                year: 2020,
                content_type: ContentType::Movie,
                language: "English".to_string(),
                owned: true,
                ripped: false, // not ripped
                childrens: false,
                owned_media: vec![MediaFormat::BluRay],
                rip_quality: vec![MediaFormat::Dvd], // but quality specified — invalid
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
            },
        })
        .await;

    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::RipQualityWhenNotRipped)),
        "ripped=false + rip_quality set must return RipQualityWhenNotRipped (HTTP 400) — got: {result:?}"
    );
}

/// DuplicateMovie: same title (case-insensitive) in same collection returns DomainError.
///
/// Maps to HTTP 409 DUPLICATE_MOVIE.
#[tokio::test]
async fn create_movie_duplicate_title_in_same_collection_returns_domain_error() {
    use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
    use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
    use mc_service::application::dtos::collection_dto::CreateCollectionDto;
    use mc_service::application::dtos::movie_dto::CreateMovieDto;
    use mc_service::application::ports::collection_repository::CollectionRepository;
    use mc_service::application::ports::movie_repository::MovieRepository;
    use mc_service::domain::errors::DomainError;
    use mc_service::domain::movie::ContentType;

    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");

    let coll_repo = MongoCollectionRepository::new(&db);
    let movie_repo = MongoMovieRepository::new(&db);

    let coll = coll_repo
        .create(
            "dup-movie-owner",
            CreateCollectionDto {
                name: "Dup Movie Test".to_string(),
                description: None,
            },
        )
        .await
        .expect("create collection failed");

    let base_dto = || CreateMovieDto {
        title: "The Matrix".to_string(),
        year: 1999,
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
    };

    movie_repo
        .create(&coll.id, "dup-movie-owner", base_dto())
        .await
        .expect("first create must succeed");

    // Same title — different case — in same collection
    let mut dup = base_dto();
    dup.title = "the matrix".to_string();
    let result = movie_repo.create(&coll.id, "dup-movie-owner", dup).await;

    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::DuplicateMovie)),
        "same title (case-insensitive) in same collection must return DuplicateMovie (HTTP 409) — got: {result:?}"
    );
}

/// MovieNotFound: get_by_id for unknown ID returns DomainError.
///
/// Maps to HTTP 404 MOVIE_NOT_FOUND.
#[tokio::test]
async fn get_movie_not_found_returns_domain_error() {
    use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
    use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
    use mc_service::application::dtos::collection_dto::CreateCollectionDto;
    use mc_service::application::ports::collection_repository::CollectionRepository;
    use mc_service::application::ports::movie_repository::MovieRepository;
    use mc_service::domain::errors::DomainError;

    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");

    let coll_repo = MongoCollectionRepository::new(&db);
    let movie_repo = MongoMovieRepository::new(&db);

    let coll = coll_repo
        .create(
            "nf-owner",
            CreateCollectionDto {
                name: "Not Found Test".to_string(),
                description: None,
            },
        )
        .await
        .expect("create collection failed");

    let result = movie_repo
        .get_by_id(&coll.id, "65b1234567890abcdef09999", "nf-owner")
        .await;

    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::MovieNotFound)),
        "unknown movie ID must return MovieNotFound (HTTP 404) — got: {result:?}"
    );
}

/// Year validation: year < 1000 returns ValidationError.
///
/// Maps to HTTP 400 INVALID_INPUT.
#[tokio::test]
async fn create_movie_invalid_year_returns_domain_error() {
    use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
    use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
    use mc_service::application::commands::create_movie::{CreateMovieCommand, CreateMovieHandler};
    use mc_service::application::dtos::collection_dto::CreateCollectionDto;
    use mc_service::application::dtos::movie_dto::CreateMovieDto;
    use mc_service::application::ports::collection_repository::CollectionRepository;
    use mc_service::application::ports::movie_repository::MovieRepository;
    use mc_service::domain::errors::DomainError;
    use mc_service::domain::movie::ContentType;
    use std::sync::Arc;

    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");

    let coll_repo: Arc<dyn CollectionRepository> =
        Arc::new(MongoCollectionRepository::new(&db)) as Arc<dyn CollectionRepository>;
    let movie_repo: Arc<dyn MovieRepository> =
        Arc::new(MongoMovieRepository::new(&db)) as Arc<dyn MovieRepository>;

    let coll = coll_repo
        .create(
            "year-owner",
            CreateCollectionDto {
                name: "Year Test".to_string(),
                description: None,
            },
        )
        .await
        .expect("create collection failed");

    let handler = CreateMovieHandler::new(movie_repo);
    let result = handler
        .handle(CreateMovieCommand {
            collection_id: coll.id.clone(),
            owner_id: "year-owner".to_string(),
            dto: CreateMovieDto {
                title: "Bad Year Movie".to_string(),
                year: 999, // < 1000 — invalid 4-digit year
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
            },
        })
        .await;

    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::ValidationError(_))),
        "year < 1000 must return ValidationError (HTTP 400 INVALID_INPUT) — got: {result:?}"
    );
}
