/// T112 — Combined search + filter integration tests for movie list
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::dtos::movie_dto::CreateMovieDto;
use mc_service::application::ports::collection_repository::CollectionRepository;
use mc_service::application::ports::movie_repository::{ListMoviesParams, MovieRepository};
use mc_service::domain::movie::ContentType;

async fn setup() -> (
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
    let coll = coll_repo
        .create(
            "sf-owner",
            CreateCollectionDto {
                name: "Search Filter Test Coll".to_string(),
                description: None,
            },
        )
        .await
        .expect("create coll failed");
    (coll_repo, movie_repo, coll.id, db)
}

fn movie(title: &str, year: i32, genre: &str) -> CreateMovieDto {
    CreateMovieDto {
        title: title.to_string(),
        year,
        content_type: ContentType::Movie,
        language: "English".to_string(),
        owned: false,
        ripped: false,
        childrens: false,
        owned_media: vec![],
        rip_quality: vec![],
        genres: vec![genre.to_string()],
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
    }
}

/// Combined search + genre filter narrows results correctly.
/// - "Star Wars" (1977, Sci-Fi) matches search "Star" and genre "Sci-Fi"
/// - "Stardust" (2007, Romance) matches search "Star" but NOT genre "Sci-Fi"
/// - "The Matrix" (1999, Sci-Fi) matches genre "Sci-Fi" but NOT search "Star"
/// → Combined: only "Star Wars"
#[tokio::test]
async fn combined_search_and_genre_filter_intersects_correctly() {
    let (_, movie_repo, coll_id, db) = setup().await;

    movie_repo
        .create(&coll_id, "sf-owner", movie("Star Wars", 1977, "Sci-Fi"))
        .await
        .expect("create Star Wars failed");
    movie_repo
        .create(&coll_id, "sf-owner", movie("Stardust", 2007, "Romance"))
        .await
        .expect("create Stardust failed");
    movie_repo
        .create(&coll_id, "sf-owner", movie("The Matrix", 1999, "Sci-Fi"))
        .await
        .expect("create The Matrix failed");

    let result = movie_repo
        .list(
            &coll_id,
            "sf-owner",
            ListMoviesParams {
                search: Some("Star".to_string()),
                genres: vec!["Sci-Fi".to_string()],
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("combined search+filter should not error");
    assert_eq!(
        list.items.len(),
        1,
        "only 'Star Wars' satisfies both search 'Star' and genre 'Sci-Fi'"
    );
    assert_eq!(list.items[0].title, "Star Wars");
}

/// Search + content_type filter combined.
/// - "Breaking Bad" (2008, Series, Action) matches search "Breaking" and contentType "Series"
/// - "Breaking Point" (2021, Movie, Drama) matches search "Breaking" but NOT contentType "Series"
/// - "Better Call Saul" (2015, Series, Drama) matches contentType "Series" but NOT search "Breaking"
/// → Combined: only "Breaking Bad"
#[tokio::test]
async fn combined_search_and_content_type_filter() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let mut series_dto = movie("Breaking Bad", 2008, "Action");
    series_dto.content_type = ContentType::Series;
    movie_repo
        .create(&coll_id, "sf-owner", series_dto)
        .await
        .expect("create Breaking Bad failed");

    movie_repo
        .create(&coll_id, "sf-owner", movie("Breaking Point", 2021, "Drama"))
        .await
        .expect("create Breaking Point failed");

    let mut saul_dto = movie("Better Call Saul", 2015, "Drama");
    saul_dto.content_type = ContentType::Series;
    movie_repo
        .create(&coll_id, "sf-owner", saul_dto)
        .await
        .expect("create Better Call Saul failed");

    let result = movie_repo
        .list(
            &coll_id,
            "sf-owner",
            ListMoviesParams {
                search: Some("Breaking".to_string()),
                content_type: Some("Series".to_string()),
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("search+content_type filter failed");
    assert_eq!(
        list.items.len(),
        1,
        "only 'Breaking Bad' satisfies both criteria"
    );
    assert_eq!(list.items[0].title, "Breaking Bad");
}

/// Search with no matching results returns empty list.
#[tokio::test]
async fn search_with_no_matches_returns_empty() {
    let (_, movie_repo, coll_id, db) = setup().await;

    movie_repo
        .create(&coll_id, "sf-owner", movie("Inception", 2010, "Sci-Fi"))
        .await
        .expect("create failed");
    movie_repo
        .create(&coll_id, "sf-owner", movie("Interstellar", 2014, "Sci-Fi"))
        .await
        .expect("create failed");

    let result = movie_repo
        .list(
            &coll_id,
            "sf-owner",
            ListMoviesParams {
                search: Some("Zephyr".to_string()),
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("search returning empty should not error");
    assert!(
        list.items.is_empty(),
        "search for non-existent title must return empty list"
    );
    assert!(list.next_cursor.is_none(), "no cursor when empty result");
}

/// Filter with no matching results returns empty list.
#[tokio::test]
async fn filter_with_no_matches_returns_empty() {
    let (_, movie_repo, coll_id, db) = setup().await;

    movie_repo
        .create(&coll_id, "sf-owner", movie("The Godfather", 1972, "Crime"))
        .await
        .expect("create failed");

    let result = movie_repo
        .list(
            &coll_id,
            "sf-owner",
            ListMoviesParams {
                genres: vec!["Horror".to_string()], // no Horror movies in collection
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("filter returning empty should not error");
    assert!(
        list.items.is_empty(),
        "filter for absent genre must return empty list"
    );
}
