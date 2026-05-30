/// T039 — Collection adapter integration tests (MongoCollectionRepository)
/// T042 — Collection HTTP integration tests (Axum router → handler → adapter)
///
/// This file is the Cargo test binary entry point.
/// All collection-related integration tests are organized as submodules.
///
/// Requires: MongoDB running at MC_DB_URL (see backend/mc-service/.env.local)
/// Run: `pnpm nx test:integration mc-service -- --test collections_test`
// Shared test helpers — accessible in all submodules as `crate::common`
mod common;

mod collections {
    // T039: Adapter layer integration tests (MongoCollectionRepository)
    pub mod create_test;
    pub mod delete_test;
    pub mod get_test;
    pub mod list_test;
    pub mod update_test;

    // T042: HTTP layer integration tests (Axum router → handler → adapter → MongoDB)
    pub mod http_test;
}
