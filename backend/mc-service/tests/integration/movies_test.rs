/// T085 — Movie adapter integration tests (MongoMovieRepository)
/// T088 — Movie HTTP integration tests (Axum router → handler → adapter)
///
/// Requires: MongoDB running at MC_DB_URL (see backend/mc-service/.env.local)
/// Run: `pnpm nx test:integration mc-service -- --test movies_test`
mod common;

mod movies {
    // T085: Adapter layer integration tests (MongoMovieRepository)
    pub mod create_test;
    pub mod delete_test;
    pub mod get_test;
    pub mod large_collection_test;
    pub mod list_test;
    pub mod search_filter_test;
    pub mod update_test;

    // T088: HTTP layer integration tests (Axum router → handler → adapter → MongoDB)
    pub mod http_create_update_test;
    pub mod http_delete_test;
    pub mod http_list_test;
}
