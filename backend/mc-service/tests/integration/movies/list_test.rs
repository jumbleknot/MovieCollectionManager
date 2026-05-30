/// T085 + T112 — Movie adapter integration tests: list with cursor pagination and filters
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::dtos::movie_dto::CreateMovieDto;
use mc_service::application::ports::collection_repository::CollectionRepository;
use mc_service::application::ports::movie_repository::{ListMoviesParams, MovieRepository};
use mc_service::domain::movie::{ContentType, UsaRating};

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
            "list-owner",
            CreateCollectionDto {
                name: "List Test Coll".to_string(),
                description: None,
            },
        )
        .await
        .expect("create coll failed");
    (coll_repo, movie_repo, coll.id, db)
}

fn movie_dto(title: &str, year: i32, genre: &str) -> CreateMovieDto {
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

#[tokio::test]
async fn list_returns_empty_for_empty_collection() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let result = movie_repo
        .list(&coll_id, "list-owner", ListMoviesParams::default())
        .await;
    crate::common::cleanup_db(&db).await;

    let list = result.expect("list should not error");
    assert!(
        list.items.is_empty(),
        "empty collection must return empty items"
    );
    assert!(list.next_cursor.is_none(), "no cursor when no movies");
}

#[tokio::test]
async fn list_returns_movies_in_collection() {
    let (_, movie_repo, coll_id, db) = setup().await;

    movie_repo
        .create(&coll_id, "list-owner", movie_dto("Movie A", 2000, "Drama"))
        .await
        .expect("create A failed");
    movie_repo
        .create(&coll_id, "list-owner", movie_dto("Movie B", 2001, "Action"))
        .await
        .expect("create B failed");

    let result = movie_repo
        .list(&coll_id, "list-owner", ListMoviesParams::default())
        .await;
    crate::common::cleanup_db(&db).await;

    let list = result.expect("list failed");
    assert_eq!(list.items.len(), 2, "should return 2 movies");
}

#[tokio::test]
async fn list_filters_by_genre() {
    let (_, movie_repo, coll_id, db) = setup().await;

    movie_repo
        .create(
            &coll_id,
            "list-owner",
            movie_dto("Drama Movie", 2000, "Drama"),
        )
        .await
        .expect("create failed");
    movie_repo
        .create(
            &coll_id,
            "list-owner",
            movie_dto("Action Movie", 2001, "Action"),
        )
        .await
        .expect("create failed");

    let params = ListMoviesParams {
        genres: vec!["Drama".to_string()],
        ..Default::default()
    };
    let result = movie_repo.list(&coll_id, "list-owner", params).await;
    crate::common::cleanup_db(&db).await;

    let list = result.expect("list with genre filter failed");
    assert_eq!(
        list.items.len(),
        1,
        "genre filter should return only Drama movies"
    );
    assert_eq!(list.items[0].title, "Drama Movie");
}

#[tokio::test]
async fn list_cursor_pagination_works() {
    let (_, movie_repo, coll_id, db) = setup().await;

    // Insert 3 movies
    for i in 1..=3 {
        movie_repo
            .create(
                &coll_id,
                "list-owner",
                movie_dto(&format!("Batch Movie {}", i), 2000 + i, "Sci-Fi"),
            )
            .await
            .expect("create failed");
    }

    // First page — batch size 50 by default, but verify cursor is None for 3 items
    let first_page = movie_repo
        .list(&coll_id, "list-owner", ListMoviesParams::default())
        .await
        .expect("first page failed");

    crate::common::cleanup_db(&db).await;

    assert_eq!(first_page.items.len(), 3, "all 3 items on first page");
    assert!(
        first_page.next_cursor.is_none(),
        "no cursor when all items fit on first page"
    );
}

// T112 — cursor advances through 50-movie batches

#[tokio::test]
async fn cursor_paginates_through_51_movies() {
    let (_, movie_repo, coll_id, db) = setup().await;

    // Insert 51 movies (unique titles to avoid duplicate constraint)
    for i in 1..=51u32 {
        movie_repo
            .create(
                &coll_id,
                "list-owner",
                movie_dto(&format!("Batch {:03}", i), 2000, "Drama"),
            )
            .await
            .expect("create failed");
    }

    // First page — should have exactly 50 items and a cursor
    let first_page = movie_repo
        .list(&coll_id, "list-owner", ListMoviesParams::default())
        .await
        .expect("first page failed");

    assert_eq!(
        first_page.items.len(),
        50,
        "first page should have 50 items"
    );
    let cursor = first_page
        .next_cursor
        .clone()
        .expect("cursor must be present when >50 items");

    // Second page — should have 1 item and no cursor
    let second_page = movie_repo
        .list(
            &coll_id,
            "list-owner",
            ListMoviesParams {
                cursor: Some(cursor),
                ..Default::default()
            },
        )
        .await
        .expect("second page failed");

    crate::common::cleanup_db(&db).await;

    assert_eq!(
        second_page.items.len(),
        1,
        "second page should have 1 remaining item"
    );
    assert!(
        second_page.next_cursor.is_none(),
        "no more pages after all items consumed"
    );
}

// T112 — search by title returns matching movies

#[tokio::test]
async fn text_search_returns_matching_titles() {
    let (_, movie_repo, coll_id, db) = setup().await;

    movie_repo
        .create(
            &coll_id,
            "list-owner",
            movie_dto("The Dark Knight", 2008, "Action"),
        )
        .await
        .expect("create failed");
    movie_repo
        .create(
            &coll_id,
            "list-owner",
            movie_dto("Inception", 2010, "Sci-Fi"),
        )
        .await
        .expect("create failed");
    movie_repo
        .create(
            &coll_id,
            "list-owner",
            movie_dto("Dark Water", 2005, "Horror"),
        )
        .await
        .expect("create failed");

    let result = movie_repo
        .list(
            &coll_id,
            "list-owner",
            ListMoviesParams {
                search: Some("Dark".to_string()),
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("text search should not error");
    assert_eq!(
        list.items.len(),
        2,
        "should return 2 movies matching 'Dark'"
    );
    let titles: Vec<&str> = list.items.iter().map(|m| m.title.as_str()).collect();
    assert!(
        titles.contains(&"The Dark Knight"),
        "The Dark Knight must be in results"
    );
    assert!(
        titles.contains(&"Dark Water"),
        "Dark Water must be in results"
    );
}

// T112 — filter by language

#[tokio::test]
async fn list_filters_by_language() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let mut french_dto = movie_dto("Amelie", 2001, "Romance");
    french_dto.language = "French".to_string();
    movie_repo
        .create(&coll_id, "list-owner", french_dto)
        .await
        .expect("create French movie failed");
    movie_repo
        .create(
            &coll_id,
            "list-owner",
            movie_dto("The Matrix", 1999, "Sci-Fi"),
        )
        .await
        .expect("create English movie failed");

    let result = movie_repo
        .list(
            &coll_id,
            "list-owner",
            ListMoviesParams {
                language: Some("French".to_string()),
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("language filter failed");
    assert_eq!(list.items.len(), 1, "only 1 French movie");
    assert_eq!(list.items[0].title, "Amelie");
}

// T112 — filter by decade (year range)

#[tokio::test]
async fn list_filters_by_decade() {
    let (_, movie_repo, coll_id, db) = setup().await;

    movie_repo
        .create(
            &coll_id,
            "list-owner",
            movie_dto("Pulp Fiction", 1994, "Crime"),
        )
        .await
        .expect("create 90s failed");
    movie_repo
        .create(
            &coll_id,
            "list-owner",
            movie_dto("The Matrix", 1999, "Sci-Fi"),
        )
        .await
        .expect("create 90s failed");
    movie_repo
        .create(
            &coll_id,
            "list-owner",
            movie_dto("Memento", 2000, "Thriller"),
        )
        .await
        .expect("create 00s failed");

    let result = movie_repo
        .list(
            &coll_id,
            "list-owner",
            ListMoviesParams {
                decade: Some(1990),
                ..Default::default()
            },
        )
        .await;

    crate::common::cleanup_db(&db).await;

    let list = result.expect("decade filter failed");
    assert_eq!(
        list.items.len(),
        2,
        "decade 1990 should return 1990–1999 movies"
    );
    let titles: Vec<&str> = list.items.iter().map(|m| m.title.as_str()).collect();
    assert!(titles.contains(&"Pulp Fiction"));
    assert!(titles.contains(&"The Matrix"));
}

// T112 — filter-options returns only collection-present values

#[tokio::test]
async fn filter_options_returns_only_present_values() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let mut action_english = movie_dto("Die Hard", 1988, "Action");
    action_english.rated = Some(UsaRating::R);
    movie_repo
        .create(&coll_id, "list-owner", action_english)
        .await
        .expect("create Die Hard failed");

    let mut scifi_french = movie_dto("Amelie", 2001, "Romance");
    scifi_french.language = "French".to_string();
    scifi_french.rated = Some(UsaRating::PG);
    scifi_french.content_type = ContentType::Movie;
    movie_repo
        .create(&coll_id, "list-owner", scifi_french)
        .await
        .expect("create Amelie failed");

    let opts = movie_repo
        .get_filter_options(&coll_id, "list-owner")
        .await
        .expect("get_filter_options failed");

    crate::common::cleanup_db(&db).await;

    // Genres: only "Action" and "Romance" should appear
    let mut genres = opts.genres.clone();
    genres.sort();
    assert!(
        genres.contains(&"Action".to_string()),
        "Action genre must be present"
    );
    assert!(
        genres.contains(&"Romance".to_string()),
        "Romance genre must be present"
    );
    assert_eq!(genres.len(), 2, "only 2 distinct genres in collection");

    // Languages: only "English" and "French"
    assert!(
        opts.languages.contains(&"English".to_string()),
        "English must be present"
    );
    assert!(
        opts.languages.contains(&"French".to_string()),
        "French must be present"
    );

    // Rated: only "R" and "PG"
    assert!(
        opts.rated.contains(&"R".to_string()),
        "R rating must be present"
    );
    assert!(
        opts.rated.contains(&"PG".to_string()),
        "PG rating must be present"
    );

    // Decades: 1980 and 2000
    assert!(opts.decades.contains(&1980), "1980s decade must be present");
    assert!(opts.decades.contains(&2000), "2000s decade must be present");
}

// T112 — filter-options returns empty for empty collection

#[tokio::test]
async fn filter_options_empty_for_empty_collection() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let opts = movie_repo
        .get_filter_options(&coll_id, "list-owner")
        .await
        .expect("get_filter_options should not error on empty collection");

    crate::common::cleanup_db(&db).await;

    assert!(opts.genres.is_empty(), "no genres in empty collection");
    assert!(
        opts.content_types.is_empty(),
        "no content types in empty collection"
    );
    assert!(opts.decades.is_empty(), "no decades in empty collection");
}
