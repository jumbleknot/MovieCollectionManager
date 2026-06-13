/// T112 / T138 — Combined search + filter integration tests for movie list
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::dtos::movie_dto::CreateMovieDto;
use mc_service::application::ports::collection_repository::CollectionRepository;
use mc_service::application::ports::movie_repository::{ListMoviesParams, MovieRepository};
use mc_service::domain::movie::{ContentType, MediaFormat};

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
        language: Some("English".to_string()),
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

// ─── T138: Search by non-title fields (regex) ────────────────────────────────

/// Search by director name returns movies that have that director.
/// Uses substring matching — "Spielberg" matches "Steven Spielberg".
#[tokio::test]
async fn search_by_director_name_returns_matching_movies() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let mut spielberg_movie = movie("Schindler's List", 1993, "Drama");
    spielberg_movie.directors = vec!["Steven Spielberg".to_string()];
    movie_repo
        .create(&coll_id, "sf-owner", spielberg_movie)
        .await
        .expect("create failed");

    let mut other_movie = movie("The Godfather", 1972, "Crime");
    other_movie.directors = vec!["Francis Ford Coppola".to_string()];
    movie_repo
        .create(&coll_id, "sf-owner", other_movie)
        .await
        .expect("create failed");

    // Partial-word search: "Spielberg" matches "Steven Spielberg"
    let result = movie_repo
        .list(
            &coll_id,
            "sf-owner",
            ListMoviesParams {
                search: Some("Spielberg".to_string()),
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("director search should not error");
    assert_eq!(
        list.items.len(),
        1,
        "only one movie has a Spielberg director"
    );
    assert_eq!(list.items[0].title, "Schindler's List");
}

/// Search by actor name returns movies that have that actor.
#[tokio::test]
async fn search_by_actor_name_returns_matching_movies() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let mut hanks_movie = movie("Forrest Gump", 1994, "Drama");
    hanks_movie.actors = vec!["Tom Hanks".to_string(), "Robin Wright".to_string()];
    movie_repo
        .create(&coll_id, "sf-owner", hanks_movie)
        .await
        .expect("create failed");

    let mut other_movie = movie("Titanic", 1997, "Romance");
    other_movie.actors = vec!["Leonardo DiCaprio".to_string()];
    movie_repo
        .create(&coll_id, "sf-owner", other_movie)
        .await
        .expect("create failed");

    // Substring search: "Hanks" finds "Tom Hanks"
    let result = movie_repo
        .list(
            &coll_id,
            "sf-owner",
            ListMoviesParams {
                search: Some("Hanks".to_string()),
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("actor search should not error");
    assert_eq!(list.items.len(), 1, "only one movie has a Hanks actor");
    assert_eq!(list.items[0].title, "Forrest Gump");
}

/// Search matches text in the outline field (substring).
#[tokio::test]
async fn search_by_outline_text_returns_matching_movies() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let mut outline_movie = movie("Mysterious Film", 2020, "Thriller");
    outline_movie.outline =
        Some("A detective investigates a series of cryptic murders".to_string());
    movie_repo
        .create(&coll_id, "sf-owner", outline_movie)
        .await
        .expect("create failed");

    let mut other_movie = movie("Happy Comedy", 2021, "Comedy");
    other_movie.outline = Some("A family goes on vacation".to_string());
    movie_repo
        .create(&coll_id, "sf-owner", other_movie)
        .await
        .expect("create failed");

    let result = movie_repo
        .list(
            &coll_id,
            "sf-owner",
            ListMoviesParams {
                search: Some("cryptic".to_string()),
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("outline search should not error");
    assert_eq!(
        list.items.len(),
        1,
        "only one movie mentions 'cryptic' in outline"
    );
    assert_eq!(list.items[0].title, "Mysterious Film");
}

/// Regex special characters in the search term are safely escaped — no panic or
/// query error when the user types e.g. "Star (Wars)".
///
/// "Star (Wars)" escaped to `Star \(Wars\)` matches the *literal* text "Star (Wars)"
/// (with parentheses), not "Star Wars".  The movie titled "Star Wars" has no parens, so
/// 0 results is correct.  The important thing is that the query succeeds (no error).
#[tokio::test]
async fn search_with_regex_special_chars_does_not_error() {
    let (_, movie_repo, coll_id, db) = setup().await;

    // Add a movie with literal parens in its title to confirm a positive match is also possible.
    movie_repo
        .create(
            &coll_id,
            "sf-owner",
            movie("Star Wars (1977)", 1977, "Sci-Fi"),
        )
        .await
        .expect("create Star Wars (1977) failed");
    movie_repo
        .create(&coll_id, "sf-owner", movie("Star Wars", 1977, "Series"))
        .await
        .expect("create Star Wars failed");

    let result = movie_repo
        .list(
            &coll_id,
            "sf-owner",
            ListMoviesParams {
                search: Some("Star Wars (1977)".to_string()), // parens are regex metacharacters
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    // The escaped regex matches only the title with literal parens — no query error.
    let list = result.expect("search with regex metacharacters should not error");
    assert_eq!(
        list.items.len(),
        1,
        "escaped parens should match 'Star Wars (1977)' but not 'Star Wars'"
    );
    assert_eq!(list.items[0].title, "Star Wars (1977)");
}

// ─── T138: Filter by ownedMedia and ripQuality ────────────────────────────────

/// ownedMedia filter returns only movies with that media format.
#[tokio::test]
async fn filter_by_owned_media_returns_matching_movies() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let mut dvd_movie = movie("DVD Classic", 1990, "Action");
    dvd_movie.owned = true;
    dvd_movie.owned_media = vec![MediaFormat::Dvd];
    movie_repo
        .create(&coll_id, "sf-owner", dvd_movie)
        .await
        .expect("create DVD movie failed");

    let mut bluray_movie = movie("Blu-Ray Blockbuster", 2010, "Action");
    bluray_movie.owned = true;
    bluray_movie.owned_media = vec![MediaFormat::BluRay];
    movie_repo
        .create(&coll_id, "sf-owner", bluray_movie)
        .await
        .expect("create Blu-Ray movie failed");

    let mut unowned_movie = movie("Digital Only", 2020, "Drama");
    unowned_movie.owned = false;
    movie_repo
        .create(&coll_id, "sf-owner", unowned_movie)
        .await
        .expect("create unowned movie failed");

    let result = movie_repo
        .list(
            &coll_id,
            "sf-owner",
            ListMoviesParams {
                owned_media: vec!["DVD".to_string()],
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("ownedMedia filter should not error");
    assert_eq!(list.items.len(), 1, "only one movie has DVD as ownedMedia");
    assert_eq!(list.items[0].title, "DVD Classic");
}

/// ripQuality filter returns only movies with that rip quality.
#[tokio::test]
async fn filter_by_rip_quality_returns_matching_movies() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let mut dvd_rip = movie("DVD Rip Movie", 1995, "Action");
    dvd_rip.ripped = true;
    dvd_rip.rip_quality = vec![MediaFormat::Dvd];
    movie_repo
        .create(&coll_id, "sf-owner", dvd_rip)
        .await
        .expect("create DVD rip failed");

    let mut bluray_rip = movie("Blu-Ray Rip Movie", 2015, "Thriller");
    bluray_rip.ripped = true;
    bluray_rip.rip_quality = vec![MediaFormat::BluRay];
    movie_repo
        .create(&coll_id, "sf-owner", bluray_rip)
        .await
        .expect("create Blu-Ray rip failed");

    let result = movie_repo
        .list(
            &coll_id,
            "sf-owner",
            ListMoviesParams {
                rip_quality: vec!["Blu-Ray".to_string()],
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("ripQuality filter should not error");
    assert_eq!(
        list.items.len(),
        1,
        "only one movie has Blu-Ray rip quality"
    );
    assert_eq!(list.items[0].title, "Blu-Ray Rip Movie");
}
