/// Comprehensive search and filter test with 100 diverse movies.
///
/// Verifies every search field and filter attribute works correctly at scale.
/// Each attribute is tested individually and in combination, asserting exact
/// counts against the known dataset.
///
/// Search fields tested: title, original_title, director, actor, movie_set,
///   tag, outline, plot.
///
/// Filter attributes tested: content_type, language, genre, decade, owned,
///   ripped, childrens, rated, owned_media, rip_quality.
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::dtos::movie_dto::CreateMovieDto;
use mc_service::application::ports::collection_repository::CollectionRepository;
use mc_service::application::ports::movie_repository::{ListMoviesParams, MovieRepository};
use mc_service::domain::movie::{ContentType, MediaFormat, UsaRating};

/// Setup: fresh test database with a single collection.
async fn setup() -> (MongoMovieRepository, String, mongodb::Database) {
    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");
    let coll_repo = MongoCollectionRepository::new(&db);
    let movie_repo = MongoMovieRepository::new(&db);
    let coll = coll_repo
        .create(
            "lc-owner",
            CreateCollectionDto {
                name: "Large Collection Test".to_string(),
                description: None,
            },
        )
        .await
        .expect("create collection failed");
    (movie_repo, coll.id, db)
}

/// Base movie DTO — minimal valid movie.
fn base_movie(title: &str, year: i32) -> CreateMovieDto {
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
        genres: vec!["Drama".to_string()],
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

/// Seed 100 movies with varied attributes. Returns the collection_id.
/// The design ensures each filter dimension has testable values.
async fn seed_100_movies(movie_repo: &MongoMovieRepository, coll_id: &str) {
    // --- Group 1: English Action Movies, 1970s–1980s (10 movies) ---
    // Owned, some ripped, R rated, directors/actors searchable
    for i in 1..=10u32 {
        let mut m = base_movie(&format!("Action Hero {i}"), 1970 + i as i32);
        m.language = Some("English".to_string());
        m.genres = vec!["Action".to_string()];
        m.content_type = ContentType::Movie;
        m.owned = true;
        m.rated = Some(UsaRating::R);
        m.directors = vec![format!("Director ActionHero{i}")];
        m.actors = vec![format!("Actor ActionHero{i}")];
        m.tags = vec![format!("action-tag-{i}")];
        m.outline = Some(format!("An action hero fights villains in scenario {i}"));
        if i <= 5 {
            m.ripped = true;
            m.rip_quality = vec![MediaFormat::BluRay];
            m.owned_media = vec![MediaFormat::BluRay];
        } else {
            m.owned_media = vec![MediaFormat::Dvd];
        }
        movie_repo
            .create(coll_id, "lc-owner", m)
            .await
            .unwrap_or_else(|e| panic!("create Action Hero {i} failed: {e:?}"));
    }

    // --- Group 2: French Drama Series, 1990s (10 movies) ---
    // Not owned, PG-13 rated
    for i in 1..=10u32 {
        let mut m = base_movie(&format!("French Drama {i}"), 1990 + i as i32 - 1);
        m.language = Some("French".to_string());
        m.genres = vec!["Drama".to_string()];
        m.content_type = ContentType::Series;
        m.owned = false;
        m.ripped = false;
        m.rated = Some(UsaRating::PG13);
        m.directors = vec![format!("Directeur FranceDrama{i}")];
        m.actors = vec![format!("Acteur FranceDrama{i}")];
        m.plot = Some(format!("Une série dramatique française, épisode {i}"));
        movie_repo
            .create(coll_id, "lc-owner", m)
            .await
            .unwrap_or_else(|e| panic!("create French Drama {i} failed: {e:?}"));
    }

    // --- Group 3: Japanese Sci-Fi Concert, 2000s (10 movies) ---
    // Owned, ripped, UHD Blu-Ray
    for i in 1..=10u32 {
        let mut m = base_movie(&format!("Nihon SciFi {i}"), 2000 + i as i32 - 1);
        m.language = Some("Japanese".to_string());
        m.genres = vec!["Sci-Fi".to_string()];
        m.content_type = ContentType::Concert;
        m.owned = true;
        m.ripped = true;
        m.rated = Some(UsaRating::NR);
        m.owned_media = vec![MediaFormat::UhdBluRay];
        m.rip_quality = vec![MediaFormat::UhdBluRay];
        m.directors = vec![format!("Kantoku NihonSciFi{i}")];
        m.tags = vec!["anime".to_string(), format!("sci-fi-jp-{i}")];
        movie_repo
            .create(coll_id, "lc-owner", m)
            .await
            .unwrap_or_else(|e| panic!("create Nihon SciFi {i} failed: {e:?}"));
    }

    // --- Group 4: Spanish Comedy Movies, 2010s (10 movies) ---
    // Children's, G rated, Blu-Ray 3D
    for i in 1..=10u32 {
        let mut m = base_movie(&format!("Comedia Espanol {i}"), 2010 + i as i32 - 1);
        m.language = Some("Spanish".to_string());
        m.genres = vec!["Comedy".to_string()];
        m.content_type = ContentType::Movie;
        m.childrens = true;
        m.owned = true;
        m.rated = Some(UsaRating::G);
        m.owned_media = vec![MediaFormat::BluRay3D];
        m.directors = vec![format!("Director ComediaES{i}")];
        m.actors = vec![format!("Actor ComediaES{i}")];
        movie_repo
            .create(coll_id, "lc-owner", m)
            .await
            .unwrap_or_else(|e| panic!("create Comedia Espanol {i} failed: {e:?}"));
    }

    // --- Group 5: Italian Romance Movies, 1980s (10 movies) ---
    // PG rated, some with Blu-Ray
    for i in 1..=10u32 {
        let mut m = base_movie(&format!("Romance Italiana {i}"), 1980 + i as i32 - 1);
        m.language = Some("Italian".to_string());
        m.genres = vec!["Romance".to_string()];
        m.content_type = ContentType::Movie;
        m.owned = i <= 7; // 7 owned, 3 not owned
        m.rated = Some(UsaRating::PG);
        if m.owned {
            m.owned_media = vec![MediaFormat::BluRay];
        }
        m.movie_set = Some(format!("Italian Romance Collection Vol{}", (i - 1) / 3 + 1));
        movie_repo
            .create(coll_id, "lc-owner", m)
            .await
            .unwrap_or_else(|e| panic!("create Romance Italiana {i} failed: {e:?}"));
    }

    // --- Group 6: German Horror Movies, 1990s (10 movies) ---
    // R rated, ripped with DVD, not children's
    for i in 1..=10u32 {
        let mut m = base_movie(&format!("Horror Deutsch {i}"), 1993 + i as i32 - 1);
        m.language = Some("German".to_string());
        m.genres = vec!["Horror".to_string()];
        m.content_type = ContentType::Movie;
        m.owned = true;
        m.ripped = true;
        m.rated = Some(UsaRating::R);
        m.owned_media = vec![MediaFormat::Dvd];
        m.rip_quality = vec![MediaFormat::Dvd];
        m.actors = vec![format!("Schauspieler HorrorDE{i}")];
        m.outline = Some(format!("Ein deutsches Horrorfilm über Schrecken {i}"));
        movie_repo
            .create(coll_id, "lc-owner", m)
            .await
            .unwrap_or_else(|e| panic!("create Horror Deutsch {i} failed: {e:?}"));
    }

    // --- Group 7: Korean Thriller Series, 2000s (10 movies) ---
    // PG-13 rated, not owned
    for i in 1..=10u32 {
        let mut m = base_movie(&format!("Thriller Korean {i}"), 2001 + i as i32 - 1);
        m.language = Some("Korean".to_string());
        m.genres = vec!["Thriller".to_string()];
        m.content_type = ContentType::Series;
        m.owned = false;
        m.rated = Some(UsaRating::PG13);
        m.directors = vec![format!("Gamdog ThrillerKR{i}")];
        m.plot = Some(format!(
            "A Korean thriller series about suspense and mystery {i}"
        ));
        movie_repo
            .create(coll_id, "lc-owner", m)
            .await
            .unwrap_or_else(|e| panic!("create Thriller Korean {i} failed: {e:?}"));
    }

    // --- Group 8: English Animation Movies, 2010s (10 movies) ---
    // Children's, G rated, Blu-Ray, ripped Blu-Ray
    for i in 1..=10u32 {
        let mut m = base_movie(&format!("Animation Kids {i}"), 2011 + i as i32 - 1);
        m.language = Some("English".to_string());
        m.genres = vec!["Animation".to_string()];
        m.content_type = ContentType::Movie;
        m.childrens = true;
        m.owned = true;
        m.ripped = true;
        m.rated = Some(UsaRating::G);
        m.owned_media = vec![MediaFormat::BluRay];
        m.rip_quality = vec![MediaFormat::BluRay];
        m.directors = vec![format!("Director AnimKids{i}")];
        m.actors = vec![format!("Voice AnimKids{i}")];
        m.tags = vec!["animated".to_string(), "family".to_string()];
        movie_repo
            .create(coll_id, "lc-owner", m)
            .await
            .unwrap_or_else(|e| panic!("create Animation Kids {i} failed: {e:?}"));
    }

    // --- Group 9: English Documentary Movies, 2020s (10 movies) ---
    // NR rated, not owned, no children's
    for i in 1..=10u32 {
        let mut m = base_movie(&format!("Documentary World {i}"), 2020 + i as i32 - 1);
        m.language = Some("English".to_string());
        m.genres = vec!["Documentary".to_string()];
        m.content_type = ContentType::Movie;
        m.owned = false;
        m.rated = Some(UsaRating::NR);
        m.directors = vec![format!("Director DocWorld{i}")];
        m.plot = Some(format!(
            "A documentary exploring global phenomena and world events {i}"
        ));
        m.runtime = Some(90 + i as i32 * 5);
        movie_repo
            .create(coll_id, "lc-owner", m)
            .await
            .unwrap_or_else(|e| panic!("create Documentary World {i} failed: {e:?}"));
    }

    // --- Group 10: English Crime Movies, 1960s (10 movies) ---
    // NC-17, some with UHD Blu-Ray, original titles (non-English)
    for i in 1..=10u32 {
        let mut m = base_movie(&format!("Crime Classic {i}"), 1960 + i as i32 - 1);
        m.language = Some("English".to_string());
        m.genres = vec!["Crime".to_string()];
        m.content_type = ContentType::Movie;
        m.owned = i <= 5; // 5 owned
        m.rated = Some(UsaRating::NC17);
        if m.owned {
            m.owned_media = vec![MediaFormat::UhdBluRay];
        }
        m.original_title = Some(format!("La Crime Classique {i}")); // searchable original_title
        m.directors = vec![format!("Director CrimeClassic{i}")];
        m.tags = vec!["classic".to_string(), "noir".to_string()];
        movie_repo
            .create(coll_id, "lc-owner", m)
            .await
            .unwrap_or_else(|e| panic!("create Crime Classic {i} failed: {e:?}"));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter tests
// ─────────────────────────────────────────────────────────────────────────────

/// All 100 movies are returned when no filters are applied (across 2 pages).
#[tokio::test]
async fn large_collection_all_movies_paginated() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let first = movie_repo
        .list(&coll_id, "lc-owner", ListMoviesParams::default())
        .await
        .expect("list page 1 failed");
    assert_eq!(first.items.len(), 50, "first page has 50 items");
    let cursor = first.next_cursor.expect("cursor must be present");

    let second = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                cursor: Some(cursor),
                ..Default::default()
            },
        )
        .await
        .expect("list page 2 failed");
    assert_eq!(second.items.len(), 50, "second page has 50 items");
    assert!(
        second.next_cursor.is_none(),
        "no more pages after 100 items"
    );

    crate::common::cleanup_db(&db).await;
}

/// Filter by content_type = Movie returns exactly the Movie entries.
#[tokio::test]
async fn filter_content_type_movie() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Groups: 1(Movie,10)+4(Movie,10)+5(Movie,10)+6(Movie,10)+8(Movie,10)+9(Movie,10)+10(Movie,10)=70
    // Groups 2 and 3 are Series(10) and Concert(10) = 20 non-Movie
    // Groups 3 is Concert(10) and Groups 2 and 7 are Series(20)
    // Actual Movie groups: 1,4,5,6,8,9,10 = 70 movies
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                content_type: Some("Movie".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter by Movie failed");

    let total = result.items.len()
        + if result.next_cursor.is_some() {
            let cursor = result.next_cursor.unwrap();
            movie_repo
                .list(
                    &coll_id,
                    "lc-owner",
                    ListMoviesParams {
                        content_type: Some("Movie".to_string()),
                        cursor: Some(cursor),
                        ..Default::default()
                    },
                )
                .await
                .expect("page 2 failed")
                .items
                .len()
        } else {
            0
        };

    crate::common::cleanup_db(&db).await;
    assert_eq!(total, 70, "70 movies have content_type=Movie");
}

/// Filter by content_type = Series returns exactly 20 Series entries.
#[tokio::test]
async fn filter_content_type_series() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Groups 2 (French Drama Series, 10) + Group 7 (Korean Thriller Series, 10) = 20
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                content_type: Some("Series".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter by Series failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 20, "20 movies have content_type=Series");
    assert!(result.next_cursor.is_none());
}

/// Filter by content_type = Concert returns exactly 10 Concert entries.
#[tokio::test]
async fn filter_content_type_concert() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 3 (Japanese Sci-Fi Concert, 10)
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                content_type: Some("Concert".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter by Concert failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        10,
        "10 movies have content_type=Concert"
    );
}

/// Filter by language = French returns exactly 10 entries.
#[tokio::test]
async fn filter_language_french() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 2 (French Drama Series, 10)
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                language: Some("French".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter by French failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 French movies");
}

/// Filter by language = Japanese returns exactly 10 entries.
#[tokio::test]
async fn filter_language_japanese() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                language: Some("Japanese".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter by Japanese failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 Japanese movies");
}

/// Filter by language = Spanish returns exactly 10 entries.
#[tokio::test]
async fn filter_language_spanish() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                language: Some("Spanish".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter by Spanish failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 Spanish movies");
}

/// Filter by language = Korean returns exactly 10 entries.
#[tokio::test]
async fn filter_language_korean() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                language: Some("Korean".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter by Korean failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 Korean movies");
}

/// Filter by genre = Action returns exactly 10 entries.
#[tokio::test]
async fn filter_genre_action() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                genres: vec!["Action".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("filter by Action failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 Action movies");
    assert!(
        result
            .items
            .iter()
            .all(|m| m.genres.contains(&"Action".to_string())),
        "all returned movies must have Action genre"
    );
}

/// Filter by genre = Sci-Fi returns exactly 10 entries.
#[tokio::test]
async fn filter_genre_sci_fi() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                genres: vec!["Sci-Fi".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("filter by Sci-Fi failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 Sci-Fi movies");
}

/// Filter by genre = Animation returns exactly 10 entries.
#[tokio::test]
async fn filter_genre_animation() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                genres: vec!["Animation".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("filter by Animation failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 Animation movies");
}

/// Filter by genre = Crime returns exactly 10 entries.
#[tokio::test]
async fn filter_genre_crime() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                genres: vec!["Crime".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("filter by Crime failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 Crime movies");
}

/// Filter by decade = 1960 returns exactly 10 entries (years 1960–1969).
#[tokio::test]
async fn filter_decade_1960s() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 10: Crime Classic 1–10, years 1960–1969
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                decade: Some(1960),
                ..Default::default()
            },
        )
        .await
        .expect("filter by 1960s failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 movies from the 1960s");
    assert!(
        result.items.iter().all(|m| m.year >= 1960 && m.year < 1970),
        "all returned movies must have year 1960–1969"
    );
}

/// Filter by decade = 1970 returns exactly 10 entries (years 1970–1979).
#[tokio::test]
async fn filter_decade_1970s() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 1: Action Hero 1–10 years 1971–1980; years 1971–1979 = 9 movies
    // BUT: Action Hero 10 is 1980, so only 9 are in the 1970s decade.
    // Wait: year = 1970 + i, i=1..=10 → years 1971, 1972, ..., 1980
    // Decade 1970 = years 1970–1979 → Action Hero 1–9 = 9 movies from 1970s
    // Action Hero 10 = 1980 = 1980s
    // Italian Romance: 1980+i-1, i=1..=10 → years 1980, 1981, ..., 1989 (all 1980s)
    // So 1970s: 9 movies
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                decade: Some(1970),
                ..Default::default()
            },
        )
        .await
        .expect("filter by 1970s failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 9, "9 movies from the 1970s (1971–1979)");
    assert!(
        result.items.iter().all(|m| m.year >= 1970 && m.year < 1980),
        "all returned movies must have year 1970–1979"
    );
}

/// Filter by decade = 1980 returns exactly 11 entries (years 1980–1989).
#[tokio::test]
async fn filter_decade_1980s() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 1 item 10: Action Hero 10, year 1980
    // Group 5 Italian Romance: years 1980–1989 (10 movies)
    // Total 1980s: 1 + 10 = 11
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                decade: Some(1980),
                ..Default::default()
            },
        )
        .await
        .expect("filter by 1980s failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        11,
        "11 movies from the 1980s (1980–1989)"
    );
    assert!(
        result.items.iter().all(|m| m.year >= 1980 && m.year < 1990),
        "all returned movies must have year 1980–1989"
    );
}

/// Filter by decade = 1990 returns movies from years 1990–1999.
#[tokio::test]
async fn filter_decade_1990s() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 2: French Drama 1–10, years 1990–1999 (10 movies)
    // Group 6: Horror Deutsch 1–10, years 1993–2002; 1993–1999 = 7 movies
    // Total 1990s: 10 + 7 = 17
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                decade: Some(1990),
                ..Default::default()
            },
        )
        .await
        .expect("filter by 1990s failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 17, "17 movies from the 1990s");
    assert!(
        result.items.iter().all(|m| m.year >= 1990 && m.year < 2000),
        "all returned movies must have year 1990–1999"
    );
}

/// Filter by decade = 2000 returns movies from years 2000–2009.
#[tokio::test]
async fn filter_decade_2000s() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 3: Nihon SciFi 1–10, years 2000–2009 (10 movies)
    // Group 6: Horror Deutsch, years 1993+i-1, i=8..=10 → years 2000, 2001, 2002 = 3 movies
    // Group 7: Korean Thriller 1–10, years 2001–2010; 2001–2009 = 9 movies
    // Total 2000s: 10 + 3 + 9 = 22
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                decade: Some(2000),
                ..Default::default()
            },
        )
        .await
        .expect("filter by 2000s failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 22, "22 movies from the 2000s");
    assert!(
        result.items.iter().all(|m| m.year >= 2000 && m.year < 2010),
        "all returned movies must have year 2000–2009"
    );
}

/// Filter by decade = 2010 returns movies from years 2010–2019.
#[tokio::test]
async fn filter_decade_2010s() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 4: Comedia Espanol 1–10, years 2010–2019 (10 movies)
    // Group 7: Korean Thriller, year 2001+i-1, i=10 → 2010 = 1 movie
    // Group 8: Animation Kids 1–10, years 2011–2020; 2011–2019 = 9 movies
    // Total 2010s: 10 + 1 + 9 = 20
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                decade: Some(2010),
                ..Default::default()
            },
        )
        .await
        .expect("filter by 2010s failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 20, "20 movies from the 2010s");
    assert!(
        result.items.iter().all(|m| m.year >= 2010 && m.year < 2020),
        "all returned movies must have year 2010–2019"
    );
}

/// Filter by decade = 2020 returns movies from years 2020–2029.
#[tokio::test]
async fn filter_decade_2020s() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 8: Animation Kids 10 → year 2020 = 1 movie
    // Group 9: Documentary World 1–10, years 2020–2029 (10 movies)
    // Total 2020s: 1 + 10 = 11
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                decade: Some(2020),
                ..Default::default()
            },
        )
        .await
        .expect("filter by 2020s failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 11, "11 movies from the 2020s");
    assert!(
        result.items.iter().all(|m| m.year >= 2020 && m.year < 2030),
        "all returned movies must have year 2020–2029"
    );
}

/// Filter by owned = true returns all owned movies.
#[tokio::test]
async fn filter_owned_true() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Owned groups: 1(10)+3(10)+4(10)+5(7)+6(10)+8(10)+10(5) = 62
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                owned: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("filter owned=true failed");

    let total = result.items.len()
        + if result.next_cursor.is_some() {
            let cursor = result.next_cursor.unwrap();
            movie_repo
                .list(
                    &coll_id,
                    "lc-owner",
                    ListMoviesParams {
                        owned: Some(true),
                        cursor: Some(cursor),
                        ..Default::default()
                    },
                )
                .await
                .expect("owned page 2 failed")
                .items
                .len()
        } else {
            0
        };

    crate::common::cleanup_db(&db).await;
    assert_eq!(total, 62, "62 movies are owned");
    // Note: 100 - 62 = 38 not owned
}

/// Filter by owned = false returns all not-owned movies.
#[tokio::test]
async fn filter_owned_false() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Not owned: 2(10)+5(3)+7(10)+9(10)+10(5) = 38
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                owned: Some(false),
                ..Default::default()
            },
        )
        .await
        .expect("filter owned=false failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 38, "38 movies are not owned");
    assert!(result.next_cursor.is_none());
}

/// Filter by ripped = true returns all ripped movies.
#[tokio::test]
async fn filter_ripped_true() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Ripped groups: 1(5)+3(10)+6(10)+8(10) = 35
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                ripped: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("filter ripped=true failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 35, "35 movies are ripped");
}

/// Filter by ripped = false returns all not-ripped movies.
#[tokio::test]
async fn filter_ripped_false() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Not ripped: 100 - 35 = 65
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                ripped: Some(false),
                ..Default::default()
            },
        )
        .await
        .expect("filter ripped=false failed");

    let total = result.items.len()
        + if result.next_cursor.is_some() {
            let cursor = result.next_cursor.unwrap();
            movie_repo
                .list(
                    &coll_id,
                    "lc-owner",
                    ListMoviesParams {
                        ripped: Some(false),
                        cursor: Some(cursor),
                        ..Default::default()
                    },
                )
                .await
                .expect("ripped=false page 2 failed")
                .items
                .len()
        } else {
            0
        };

    crate::common::cleanup_db(&db).await;
    assert_eq!(total, 65, "65 movies are not ripped");
}

/// Filter by childrens = true returns exactly 20 children's movies.
#[tokio::test]
async fn filter_childrens_true() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Childrens groups: 4(10) Spanish Comedy + 8(10) Animation = 20
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                childrens: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("filter childrens=true failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 20, "20 children's movies");
    assert!(
        result.items.iter().all(|m| m.childrens),
        "all returned movies must have childrens=true"
    );
}

/// Filter by USA rating = G returns exactly 20 movies (Spanish Comedy 10 + Animation 10).
#[tokio::test]
async fn filter_rated_g() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                rated: Some("G".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter rated=G failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 20, "20 G-rated movies");
}

/// Filter by USA rating = R returns exactly 20 movies (Action 10 + Horror 10).
#[tokio::test]
async fn filter_rated_r() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                rated: Some("R".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter rated=R failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 20, "20 R-rated movies");
}

/// Filter by USA rating = PG-13 returns exactly 20 movies (French Drama 10 + Korean Thriller 10).
#[tokio::test]
async fn filter_rated_pg13() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                rated: Some("PG-13".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter rated=PG-13 failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 20, "20 PG-13-rated movies");
}

/// Filter by USA rating = NC-17 returns exactly 10 movies (Crime Classic group).
#[tokio::test]
async fn filter_rated_nc17() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                rated: Some("NC-17".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter rated=NC-17 failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 NC-17-rated movies");
}

/// Filter by USA rating = NR returns exactly 20 movies (Japanese Sci-Fi 10 + Documentary 10).
#[tokio::test]
async fn filter_rated_nr() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                rated: Some("NR".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("filter rated=NR failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 20, "20 NR-rated movies");
}

/// Filter by owned_media = Blu-Ray returns movies with Blu-Ray in owned_media.
#[tokio::test]
async fn filter_owned_media_bluray() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 1 (first 5): Blu-Ray = 5
    // Group 5 (Italian owned): Blu-Ray = 7
    // Group 8 (Animation): Blu-Ray = 10
    // Total Blu-Ray: 22
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                owned_media: vec!["Blu-Ray".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("filter owned_media=Blu-Ray failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        22,
        "22 movies with Blu-Ray in owned_media"
    );
}

/// Filter by owned_media = DVD returns movies with DVD in owned_media.
#[tokio::test]
async fn filter_owned_media_dvd() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 1 (last 5): DVD = 5
    // Group 6 (Horror): DVD = 10
    // Total DVD: 15
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                owned_media: vec!["DVD".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("filter owned_media=DVD failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 15, "15 movies with DVD in owned_media");
}

/// Filter by owned_media = UHD Blu-Ray returns movies with UHD in owned_media.
#[tokio::test]
async fn filter_owned_media_uhd_bluray() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 3 (Japanese): UHD Blu-Ray = 10
    // Group 10 (Crime, first 5 owned): UHD Blu-Ray = 5
    // Total UHD: 15
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                owned_media: vec!["UHD Blu-Ray".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("filter owned_media=UHD Blu-Ray failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        15,
        "15 movies with UHD Blu-Ray in owned_media"
    );
}

/// Filter by rip_quality = Blu-Ray returns movies with Blu-Ray rip quality.
#[tokio::test]
async fn filter_rip_quality_bluray() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 1 (first 5 ripped): Blu-Ray rip = 5
    // Group 8 (Animation ripped): Blu-Ray rip = 10
    // Total: 15
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                rip_quality: vec!["Blu-Ray".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("filter rip_quality=Blu-Ray failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 15, "15 movies with Blu-Ray rip quality");
}

/// Filter by rip_quality = DVD returns movies with DVD rip quality.
#[tokio::test]
async fn filter_rip_quality_dvd() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 6 (Horror): DVD rip = 10
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                rip_quality: vec!["DVD".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("filter rip_quality=DVD failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 movies with DVD rip quality");
}

/// Filter by rip_quality = UHD Blu-Ray returns exactly 10 movies (Japanese Sci-Fi).
#[tokio::test]
async fn filter_rip_quality_uhd_bluray() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 3 (Japanese Sci-Fi): UHD Blu-Ray rip = 10
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                rip_quality: vec!["UHD Blu-Ray".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("filter rip_quality=UHD Blu-Ray failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        10,
        "10 movies with UHD Blu-Ray rip quality"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Search tests — each searchable field
// ─────────────────────────────────────────────────────────────────────────────

/// Text search by title prefix returns matching movies.
#[tokio::test]
async fn search_by_title() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // All Group 3 titles start with "Nihon SciFi"
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                search: Some("Nihon".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("search by title failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        10,
        "10 movies match title search 'Nihon'"
    );
}

/// Text search by original_title finds movies whose original_title contains the term.
#[tokio::test]
async fn search_by_original_title() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 10 has original_title "La Crime Classique {i}" → search "Classique"
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                search: Some("Classique".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("search by original_title failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        10,
        "10 movies match original_title search 'Classique'"
    );
}

/// Text search by director name returns matching movies.
#[tokio::test]
async fn search_by_director() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 9 directors are "Director DocWorld{i}" → search "DocWorld5" returns 1
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                search: Some("DocWorld5".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("search by director failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 1, "1 movie has director 'DocWorld5'");
    assert_eq!(result.items[0].title, "Documentary World 5");
}

/// Text search by actor name returns matching movies.
#[tokio::test]
async fn search_by_actor() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 4: actors are "Actor ComediaES{i}" → search "ComediaES7" returns 1
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                search: Some("ComediaES7".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("search by actor failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 1, "1 movie has actor 'ComediaES7'");
    assert_eq!(result.items[0].title, "Comedia Espanol 7");
}

/// Text search by tag finds movies containing that tag.
#[tokio::test]
async fn search_by_tag() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 8 (Animation) tags include "animated" and "family" on all 10 movies
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                search: Some("animated".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("search by tag failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 movies have tag 'animated'");
}

/// Text search by outline content finds matching movies.
#[tokio::test]
async fn search_by_outline() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 1 outlines contain "action hero fights villains in scenario"
    // Search for unique word "villains" returns all 10 Action Hero movies
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                search: Some("villains".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("search by outline failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        10,
        "10 movies have 'villains' in outline"
    );
}

/// Text search by plot content finds matching movies.
#[tokio::test]
async fn search_by_plot() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 7 plots contain "suspense and mystery" → search "suspense" returns 10
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                search: Some("suspense".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("search by plot failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 movies have 'suspense' in plot");
}

/// Text search by movie_set name finds all movies in that set.
#[tokio::test]
async fn search_by_movie_set() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    // Group 5 movie_set = "Italian Romance Collection Vol1/2/3"
    // "Italian Romance Collection Vol2" has movies 4,5,6 (i=4,5,6)
    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                search: Some("Italian Romance Collection".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("search by movie_set failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        10,
        "all 10 Italian Romance movies are in a collection set"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Combined filter tests
// ─────────────────────────────────────────────────────────────────────────────

/// Combined: language=Japanese + content_type=Concert → exactly 10 (Group 3).
#[tokio::test]
async fn combined_language_and_content_type() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                language: Some("Japanese".to_string()),
                content_type: Some("Concert".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("combined language+content_type failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 Japanese Concert movies");
}

/// Combined: genre=Action + ripped=true → exactly 5 (Group 1, first 5).
#[tokio::test]
async fn combined_genre_and_ripped() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                genres: vec!["Action".to_string()],
                ripped: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("combined genre+ripped failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 5, "5 ripped Action movies");
}

/// Combined: childrens=true + genre=Animation → exactly 10 (Group 8).
#[tokio::test]
async fn combined_childrens_and_genre() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                childrens: Some(true),
                genres: vec!["Animation".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("combined childrens+genre failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 Animation children's movies");
}

/// Combined: rated=G + owned=true → exactly 20 (Spanish Comedy 10 + Animation 10).
#[tokio::test]
async fn combined_rated_g_and_owned() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                rated: Some("G".to_string()),
                owned: Some(true),
                ..Default::default()
            },
        )
        .await
        .expect("combined rated=G + owned=true failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 20, "20 G-rated owned movies");
}

/// Combined: language=German + genre=Horror + rated=R → exactly 10.
#[tokio::test]
async fn combined_language_genre_rated() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                language: Some("German".to_string()),
                genres: vec!["Horror".to_string()],
                rated: Some("R".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("combined German+Horror+R failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        10,
        "10 German Horror R-rated movies (Group 6)"
    );
}

/// Combined: owned_media=UHD Blu-Ray + rip_quality=UHD Blu-Ray → exactly 10 (Group 3).
#[tokio::test]
async fn combined_owned_media_and_rip_quality_uhd() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                owned_media: vec!["UHD Blu-Ray".to_string()],
                rip_quality: vec!["UHD Blu-Ray".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("combined UHD owned+rip failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        10,
        "10 movies with UHD Blu-Ray owned+rip"
    );
}

/// Combined: search + genre + language → precise intersection.
/// Search "Documentary" + genre=Documentary + language=English → 10 (Group 9).
#[tokio::test]
async fn combined_search_and_genre_and_language() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                search: Some("Documentary".to_string()),
                genres: vec!["Documentary".to_string()],
                language: Some("English".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("combined search+genre+language failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        10,
        "10 English Documentary movies matching title search"
    );
}

/// Combined: decade=1960 + genre=Crime → exactly 10 (Group 10).
#[tokio::test]
async fn combined_decade_and_genre() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                decade: Some(1960),
                genres: vec!["Crime".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("combined decade+genre failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(result.items.len(), 10, "10 Crime movies from the 1960s");
}

/// Multi-genre filter (OR): genres=[Action, Horror] → exactly 20 movies.
#[tokio::test]
async fn filter_multiple_genres_or_logic() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let result = movie_repo
        .list(
            &coll_id,
            "lc-owner",
            ListMoviesParams {
                genres: vec!["Action".to_string(), "Horror".to_string()],
                ..Default::default()
            },
        )
        .await
        .expect("multi-genre OR filter failed");

    crate::common::cleanup_db(&db).await;
    assert_eq!(
        result.items.len(),
        20,
        "20 movies with genre Action OR Horror"
    );
    assert!(
        result
            .items
            .iter()
            .all(|m| m.genres.contains(&"Action".to_string())
                || m.genres.contains(&"Horror".to_string())),
        "all returned movies must have Action or Horror genre"
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter options with 100 movies
// ─────────────────────────────────────────────────────────────────────────────

/// Filter options with 100 movies returns all distinct values present.
#[tokio::test]
async fn filter_options_100_movies() {
    let (movie_repo, coll_id, db) = setup().await;
    seed_100_movies(&movie_repo, &coll_id).await;

    let opts = movie_repo
        .get_filter_options(&coll_id, "lc-owner")
        .await
        .expect("get_filter_options failed");

    crate::common::cleanup_db(&db).await;

    // All 10 genres present
    assert_eq!(opts.genres.len(), 10, "10 distinct genres");
    let expected_genres = [
        "Action",
        "Drama",
        "Sci-Fi",
        "Comedy",
        "Romance",
        "Horror",
        "Thriller",
        "Animation",
        "Documentary",
        "Crime",
    ];
    for g in &expected_genres {
        assert!(
            opts.genres.contains(&g.to_string()),
            "genre '{g}' must be present"
        );
    }

    // All 3 content types present
    assert_eq!(opts.content_types.len(), 3, "3 distinct content types");

    // 7 distinct ratings present (G, PG, PG-13, R, NC-17, NR, PG-13 duplicated in 2 groups)
    // Actual ratings: G(2 groups), PG(1 group), PG-13(2 groups), R(2 groups), NC-17(1), NR(2)
    // Distinct: G, PG, PG-13, R, NC-17, NR = 6 ratings
    assert_eq!(opts.rated.len(), 6, "6 distinct USA ratings");

    // 6 distinct languages
    let expected_langs = [
        "English", "French", "Japanese", "Spanish", "Italian", "German", "Korean",
    ];
    for l in &expected_langs {
        assert!(
            opts.languages.contains(&l.to_string()),
            "language '{l}' must be present"
        );
    }

    // Decades: 1960s, 1970s, 1980s, 1990s, 2000s, 2010s, 2020s = 7 distinct decades
    assert_eq!(opts.decades.len(), 7, "7 distinct decades");
    let expected_decades = [1960i32, 1970, 1980, 1990, 2000, 2010, 2020];
    for d in &expected_decades {
        assert!(opts.decades.contains(d), "decade {d} must be present");
    }
}
