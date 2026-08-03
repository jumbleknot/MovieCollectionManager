use std::sync::Arc;

use axum::{
    middleware::{self, from_fn},
    routing::get,
    Extension, Router,
};
use axum_keycloak_auth::instance::{KeycloakAuthInstance, KeycloakConfig};
use metrics_exporter_prometheus::PrometheusBuilder;
use mongodb::Database;

use crate::adapters::mongodb::{
    collection_repository::MongoCollectionRepository, movie_repository::MongoMovieRepository,
};
use crate::api::{
    collections::{
        create::create_collection, delete::delete_collection, get::get_collection,
        list::list_collections, update::update_collection,
    },
    health::health_handler,
    metrics::metrics_handler,
    middleware::{
        auth::{build_auth_layer, require_app_role},
        logging::logging_middleware,
    },
    movies::{
        count::count_movies, create::create_movie, delete::delete_movie,
        filter_options::get_filter_options, get::get_movie, list::list_movies,
        movie_metadata::get_movie_metadata, update::update_movie,
    },
    state::AppState,
};
use crate::application::commands::{
    create_collection::CreateCollectionHandler, create_movie::CreateMovieHandler,
    delete_collection::DeleteCollectionHandler, delete_movie::DeleteMovieHandler,
    set_default_collection::SetDefaultCollectionHandler,
    update_collection::UpdateCollectionHandler, update_movie::UpdateMovieHandler,
};
use crate::application::ports::{
    collection_repository::CollectionRepository, movie_repository::MovieRepository,
};
use crate::application::queries::{
    count_movies::CountMoviesHandler, get_collection::GetCollectionHandler,
    get_filter_options::GetFilterOptionsHandler, get_movie::GetMovieHandler,
    list_collections::ListCollectionsHandler, list_movies::ListMoviesHandler,
};
use crate::config::Config;

/// Build and return the fully-wired Axum router.
///
/// Architecture:
/// - `protected` sub-router: all `/api/v1/` business endpoints, guarded centrally by
///   `KeycloakAuthLayer<Role>`. Individual handlers use `KeycloakToken<Role>` only to
///   *read* claims (e.g., `token.subject`) after the layer has already enforced auth.
/// - `public` sub-router: `/health` (no auth required — liveness probe).
/// - Logging middleware applied to the top-level router so every request is traced.
pub async fn build(db: Database, config: &Config) -> anyhow::Result<Router> {
    let (router, _auth_instance) = build_with_auth_handle(db, config).await?;
    Ok(router)
}

/// Same as [`build`], but additionally returns the `KeycloakAuthInstance` driving the
/// auth layer.
///
/// Wiring and behaviour are identical to [`build`] — this only hands back a handle to
/// the instance that [`build`] otherwise drops.
///
/// Integration tests need it: `KeycloakAuthService::poll_ready` asserts
/// `discovery.is_pending()` while `discovery.version() == 0`, and
/// `KeycloakAuthInstance::new` sets that `pending` flag *inside* a `tokio::spawn`. On a
/// current-thread runtime nothing yields between construction and the first request, so
/// the assert fires. Awaiting `is_operational()` on this handle before the first request
/// drives `version()` past 0, after which the assert is never evaluated.
pub async fn build_with_auth_handle(
    db: Database,
    config: &Config,
) -> anyhow::Result<(Router, Arc<KeycloakAuthInstance>)> {
    // ── Repositories (Arc-wrapped for shared ownership across handlers) ──────────
    // Explicit `as Arc<dyn Trait>` coercion is required to convert from the
    // concrete type to the trait object before passing to handler constructors.
    let collection_repo: Arc<dyn CollectionRepository> =
        Arc::new(MongoCollectionRepository::new(&db)) as Arc<dyn CollectionRepository>;
    let movie_repo: Arc<dyn MovieRepository> =
        Arc::new(MongoMovieRepository::new(&db)) as Arc<dyn MovieRepository>;

    // ── Application-layer handlers ────────────────────────────────────────────────
    let state = Arc::new(AppState {
        // Collection commands
        create_collection: CreateCollectionHandler::new(Arc::clone(&collection_repo)),
        update_collection: UpdateCollectionHandler::new(Arc::clone(&collection_repo)),
        delete_collection: DeleteCollectionHandler::new(Arc::clone(&collection_repo)),
        set_default_collection: SetDefaultCollectionHandler::new(Arc::clone(&collection_repo)),

        // Collection queries
        list_collections: ListCollectionsHandler::new(Arc::clone(&collection_repo)),
        get_collection: GetCollectionHandler::new(Arc::clone(&collection_repo)),

        // Movie commands — DAC: each authorizes against the parent collection's ACL
        create_movie: CreateMovieHandler::new(
            Arc::clone(&movie_repo),
            Arc::clone(&collection_repo),
        ),
        update_movie: UpdateMovieHandler::new(
            Arc::clone(&movie_repo),
            Arc::clone(&collection_repo),
        ),
        delete_movie: DeleteMovieHandler::new(
            Arc::clone(&movie_repo),
            Arc::clone(&collection_repo),
        ),

        // Movie queries — DAC: each authorizes against the parent collection's ACL
        list_movies: ListMoviesHandler::new(Arc::clone(&movie_repo), Arc::clone(&collection_repo)),
        count_movies: CountMoviesHandler::new(
            Arc::clone(&movie_repo),
            Arc::clone(&collection_repo),
        ),
        get_movie: GetMovieHandler::new(Arc::clone(&movie_repo), Arc::clone(&collection_repo)),
        get_filter_options: GetFilterOptionsHandler::new(
            Arc::clone(&movie_repo),
            Arc::clone(&collection_repo),
        ),
    });

    // ── Prometheus metrics recorder ────────────────────────────────────────────
    // Install a global Prometheus recorder. The `PrometheusHandle` is shared via
    // `axum::Extension` so the `/metrics` handler can call `handle.render()`.
    //
    // `install_recorder()` registers as the process-global metrics sink. It errors
    // if already installed — which happens when `build()` is called multiple times
    // in integration tests (each test calls `build()` in the same process).
    // In that case we fall back to building a fresh recorder without re-registering,
    // so the handle still returns valid Prometheus text (empty in tests, but correct
    // format), and the endpoint returns 200 as required by T163a.
    let prometheus_handle = match PrometheusBuilder::new().install_recorder() {
        Ok(handle) => handle,
        Err(_) => {
            // Already installed (e.g., integration tests calling build() multiple times).
            // Build an isolated recorder whose handle returns valid Prometheus format.
            PrometheusBuilder::new().build_recorder().handle()
        }
    };

    // ── Keycloak auth instance (fetches JWKS once on startup) ────────────────────
    let keycloak_config = KeycloakConfig::builder()
        .server(config.keycloak_url.parse()?)
        .realm(config.keycloak_realm.clone())
        .build();
    let keycloak_instance = Arc::new(KeycloakAuthInstance::new(keycloak_config));
    let auth_layer = build_auth_layer(Arc::clone(&keycloak_instance), &config.keycloak_client_id);

    // ── Protected sub-router ─────────────────────────────────────────────────────
    // ALL /api/v1/ routes sit behind `auth_layer`. The layer rejects any request
    // that lacks a valid JWT or the required role — no per-handler JWT guard needed.
    let collections_routes = Router::new()
        .route("/", get(list_collections).post(create_collection))
        .route(
            "/{id}",
            get(get_collection)
                .patch(update_collection)
                .delete(delete_collection),
        )
        .route("/{id}/movies", get(list_movies).post(create_movie))
        // filter-options + count must appear BEFORE /{movieId} to avoid route shadowing
        .route("/{id}/movies/filter-options", get(get_filter_options))
        .route("/{id}/movies/count", get(count_movies))
        .route(
            "/{id}/movies/{movieId}",
            get(get_movie).put(update_movie).delete(delete_movie),
        );

    // Layer order (Tower): last `.layer()` is outermost (runs first on requests).
    // auth_layer (outermost) → validates JWT, populates Extension<KeycloakToken<Role>>
    // from_fn(require_app_role) (inner) → enforces mc-user OR mc-admin role
    let protected = Router::new()
        .nest("/collections", collections_routes)
        // 047 US4 (RQ-4): publishes the option values a movie accepts, so the conversational
        // assistant can ask the domain instead of holding a copy. A sibling of /collections
        // INSIDE this router, so it inherits auth_layer + require_app_role — no per-handler
        // guard. Not collection-scoped and returns no user data, so no DAC check applies.
        .route("/movie-metadata", get(get_movie_metadata))
        .layer(from_fn(require_app_role))
        .layer(auth_layer)
        .with_state(Arc::clone(&state));

    // ── Public sub-router ─────────────────────────────────────────────────────────
    // /health and /metrics are reachable without auth.
    // /health: liveness probe for Docker / k8s.
    // /metrics: Prometheus scrape endpoint (scrapers do not authenticate).
    let public = Router::new()
        .route("/health", get(health_handler))
        .route("/metrics", get(metrics_handler));

    // ── Top-level router ──────────────────────────────────────────────────────────
    // Logging middleware applied globally so every request (protected and public) is
    // traced with a UUID request_id, method, path, status, and duration_ms.
    // PrometheusHandle is available via Extension on all routes.
    let app = Router::new()
        .nest("/api/v1", protected)
        .merge(public)
        .layer(Extension(prometheus_handle))
        .layer(middleware::from_fn(logging_middleware));

    Ok((app, keycloak_instance))
}
