/// Shared test helpers for mc-service integration tests.
///
/// Each test must call `test_db()` to get an isolated database instance.
/// The database name includes the test name to prevent interference between
/// concurrent test runs (when `--test-threads > 1`).
///
/// Requires: `MC_DB_URL` env var or `.env.local` with a valid MongoDB URL.
use mongodb::{options::ClientOptions, Client, Database};
use uuid::Uuid;

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
