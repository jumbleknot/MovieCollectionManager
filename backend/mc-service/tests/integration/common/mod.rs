//! Shared test helpers for mc-service integration tests.
//!
//! Each test must call `test_db()` to get an isolated database instance.
//! The database name includes the test name to prevent interference between
//! concurrent test runs (when `--test-threads > 1`).
//!
//! Requires: `MC_DB_URL` env var or `.env.local` with a valid MongoDB URL.
//!
//! Each binary uses a different subset of these helpers, so unused-item warnings
//! here are structural rather than a signal of dead code.
#![allow(dead_code)]

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum_keycloak_auth::instance::KeycloakAuthInstance;
use mongodb::{options::ClientOptions, Client, Database};
use uuid::Uuid;

/// How long to wait for Keycloak OIDC discovery before failing a test outright.
const JWKS_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Connect to MongoDB and return a database with a unique name per test run.
/// The database is NOT automatically cleaned up — each test should drop it on completion.
pub async fn test_db() -> Database {
    let _ = dotenvy::from_filename("backend/mc-service/.env.local");
    let _ = dotenvy::dotenv();

    let url =
        std::env::var("MC_DB_URL").unwrap_or_else(|_| "mongodb://localhost:27017".to_string());

    let mut opts = ClientOptions::parse(&url).await.expect("Invalid MC_DB_URL");
    opts.app_name = Some("mc-service-integration-tests".to_string());

    let client = Client::with_options(opts).expect("MongoDB client creation failed");

    // Unique DB name per test run prevents cross-test contamination
    let db_name = format!("mc_test_{}", Uuid::new_v4().simple());
    client.database(&db_name)
}

/// Drop the database after a test — call in an async drop pattern.
pub async fn cleanup_db(db: &Database) {
    db.drop().await.ok();
}

/// Block until Keycloak OIDC discovery has **succeeded**, or the timeout expires.
///
/// Why this exists (PRD-McServiceHttpAuthzIntegration §3.1a): `axum-keycloak-auth`
/// 0.8.3's `KeycloakAuthService::poll_ready` asserts `discovery.is_pending()` while
/// `discovery.version() == 0`, but `KeycloakAuthInstance::new` only sets that
/// `pending` flag *inside* a `tokio::spawn`. On the current-thread runtime that
/// `#[tokio::test]` uses, nothing yields between constructing the router and the
/// first request, so the discovery task has never been polled and the assert fires.
/// That is what got the HTTP auth tests `#[ignore]`d — it read as JWKS "flakiness"
/// but is a deterministic ordering bug.
///
/// Waiting for `is_operational()` drives `version()` past 0, after which the assert
/// branch is never taken again for the life of the process.
///
/// Gating on *success* rather than merely yielding is deliberate: `version` is
/// incremented even when discovery ends in `Err`, so a service pointed at a dead
/// Keycloak still reports ready and still answers 401 to an unauthenticated
/// request. Without this gate the whole auth-negative suite would pass green with
/// no identity provider at all — see the two guards at the end of `health_test.rs`
/// (`unauthenticated_401_is_returned_even_when_keycloak_is_unreachable` and
/// `readiness_gate_reports_not_operational_for_unreachable_keycloak`).
pub async fn wait_until_operational(instance: &KeycloakAuthInstance, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if instance.is_operational().await {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Build the real Axum router against a fresh test database, with JWKS discovery
/// already complete.
///
/// Shared by every HTTP-level integration test so the readiness gate cannot be
/// forgotten in one binary and silently reintroduce the `is_pending()` panic.
pub async fn build_test_app() -> axum::Router {
    build_test_app_with_auth_instance().await.0
}

/// As [`build_test_app`], but also hands back the auth instance for tests that need
/// to assert on discovery state itself.
pub async fn build_test_app_with_auth_instance() -> (axum::Router, Arc<KeycloakAuthInstance>) {
    let db = test_db().await;

    // MC_SERVICE_PORT is irrelevant here (nothing binds); KEYCLOAK_* must be reachable.
    let config = mc_service::config::Config::from_env()
        .expect("Missing test configuration — ensure .env.local exists in backend/mc-service/");

    let (app, auth_instance) = mc_service::api::router::build_with_auth_handle(db, &config)
        .await
        .expect("Router build failed");

    assert!(
        wait_until_operational(&auth_instance, JWKS_READY_TIMEOUT).await,
        "Keycloak OIDC discovery did not become operational within {:?} — is Keycloak \
         reachable at {}? Refusing to run: without JWKS the auth tests would pass for \
         the wrong reason.",
        JWKS_READY_TIMEOUT,
        config.keycloak_url
    );

    (app, auth_instance)
}
