pub mod adapters;
/// mc-service library root.
///
/// Exposes all modules so integration tests (in `tests/integration/`) can
/// reference internal types without the modules being `pub(crate)` only.
pub mod api;
pub mod application;
pub mod config;
pub mod domain;
