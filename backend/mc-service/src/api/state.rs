use crate::application::commands::{
    create_collection::CreateCollectionHandler, create_movie::CreateMovieHandler,
    delete_collection::DeleteCollectionHandler, delete_movie::DeleteMovieHandler,
    set_default_collection::SetDefaultCollectionHandler,
    update_collection::UpdateCollectionHandler, update_movie::UpdateMovieHandler,
};
use crate::application::queries::{
    count_movies::CountMoviesHandler, get_collection::GetCollectionHandler,
    get_filter_options::GetFilterOptionsHandler, get_movie::GetMovieHandler,
    list_collections::ListCollectionsHandler, list_movies::ListMoviesHandler,
};

/// Shared application state injected into all Axum handlers via `State<Arc<AppState>>`.
pub struct AppState {
    // Collection command handlers
    pub create_collection: CreateCollectionHandler,
    pub update_collection: UpdateCollectionHandler,
    pub delete_collection: DeleteCollectionHandler,
    pub set_default_collection: SetDefaultCollectionHandler,

    // Collection query handlers
    pub list_collections: ListCollectionsHandler,
    pub get_collection: GetCollectionHandler,

    // Movie command handlers
    pub create_movie: CreateMovieHandler,
    pub update_movie: UpdateMovieHandler,
    pub delete_movie: DeleteMovieHandler,

    // Movie query handlers
    pub list_movies: ListMoviesHandler,
    pub count_movies: CountMoviesHandler,
    pub get_movie: GetMovieHandler,
    pub get_filter_options: GetFilterOptionsHandler,
}
