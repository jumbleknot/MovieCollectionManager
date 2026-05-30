/// T143 — HTTP integration tests for DELETE /api/v1/collections/:id/movies/:movieId.
///
/// Tests the full HTTP layer (Axum router → handler → application → repository) without
/// mock objects. Requires MongoDB + Keycloak running.
///
/// Authenticated DELETE tests (204 happy path, 404 MOVIE_NOT_FOUND, 404 COLLECTION_NOT_FOUND)
/// require a valid Keycloak JWT and are verified during E2E (T152). HTTP-layer tests that
/// do not require auth are covered below.
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

// ── T143: Unauthenticated DELETE ──────────────────────────────────────────────

/// DELETE /api/v1/collections/:id/movies/:movieId without a JWT returns 401.
#[tokio::test]
#[ignore = "requires full-stack (Keycloak + axum-keycloak-auth JWKS timing); verified in E2E"]
async fn delete_movie_returns_401_without_jwt() {
    let app = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/v1/collections/65b1234567890abcdef01234/movies/65b1234567890abcdef09999")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "DELETE /movies/:movieId without JWT must return 401"
    );
}

// ── T143: Route existence verification ───────────────────────────────────────

/// Verify DELETE /movies/:movieId route is wired (returns 401 not 404).
#[tokio::test]
#[ignore = "requires full-stack (Keycloak + axum-keycloak-auth JWKS timing); verified in E2E"]
async fn delete_movie_route_is_wired_not_404() {
    let app = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri("/api/v1/collections/65b1234567890abcdef01234/movies/65b1234567890abcdef09999")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_ne!(
        response.status(),
        StatusCode::NOT_FOUND,
        "DELETE /movies/:movieId must not return 404 — route must be wired"
    );
}

// ── T143: Adapter layer — delete removes movie from DB ───────────────────────

/// Verify that the adapter correctly removes a movie and then returns MovieNotFound.
/// This test does not need a JWT — it tests the repository directly.
#[tokio::test]
async fn delete_movie_adapter_removes_from_db() {
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
            "http-del-owner",
            CreateCollectionDto {
                name: "HTTP Delete Test".to_string(),
                description: None,
            },
        )
        .await
        .expect("create coll failed");

    let movie = movie_repo
        .create(
            &coll.id,
            "http-del-owner",
            CreateMovieDto {
                title: "To HTTP Delete".to_string(),
                year: 2020,
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
        )
        .await
        .expect("create movie failed");

    // Delete the movie
    movie_repo
        .delete(&coll.id, &movie.id, "http-del-owner")
        .await
        .expect("delete failed");

    // Verify it's gone
    let get_result = movie_repo
        .get_by_id(&coll.id, &movie.id, "http-del-owner")
        .await;

    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(get_result, Err(DomainError::MovieNotFound)),
        "movie must not be found after deletion via adapter"
    );
}
