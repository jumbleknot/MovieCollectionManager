/// T071b (US4) — movie count integration tests against real Mongo (`count_documents`).
/// Proves the server-side count agrees with the filtered list and ignores the pagination cursor.
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::dtos::movie_dto::CreateMovieDto;
use mc_service::application::ports::collection_repository::CollectionRepository;
use mc_service::application::ports::movie_repository::{ListMoviesParams, MovieRepository};
use mc_service::domain::movie::ContentType;

async fn setup() -> (MongoMovieRepository, String, mongodb::Database) {
    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");
    let coll_repo = MongoCollectionRepository::new(&db);
    let movie_repo = MongoMovieRepository::new(&db);
    let coll = coll_repo
        .create(
            "count-owner",
            CreateCollectionDto {
                name: "Count Test Coll".to_string(),
                description: None,
            },
        )
        .await
        .expect("create coll failed");
    (movie_repo, coll.id, db)
}

fn movie(title: &str, genre: &str) -> CreateMovieDto {
    CreateMovieDto {
        title: title.to_string(),
        year: 2000,
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

#[tokio::test]
async fn count_all_returns_total() {
    let (movie_repo, coll_id, db) = setup().await;
    for (t, g) in [("A", "Sci-Fi"), ("B", "Sci-Fi"), ("C", "Romance")] {
        movie_repo
            .create(&coll_id, "count-owner", movie(t, g))
            .await
            .expect("seed failed");
    }
    let n = movie_repo
        .count(&coll_id, "count-owner", ListMoviesParams::default())
        .await;
    crate::common::cleanup_db(&db).await;
    assert_eq!(n.expect("count should not error"), 3);
}

#[tokio::test]
async fn count_with_genre_filter_matches_filtered_list() {
    let (movie_repo, coll_id, db) = setup().await;
    for (t, g) in [("A", "Sci-Fi"), ("B", "Sci-Fi"), ("C", "Romance")] {
        movie_repo
            .create(&coll_id, "count-owner", movie(t, g))
            .await
            .expect("seed failed");
    }
    let params = ListMoviesParams {
        genres: vec!["Sci-Fi".to_string()],
        ..Default::default()
    };
    let count = movie_repo
        .count(&coll_id, "count-owner", params.clone())
        .await
        .expect("count");
    let list = movie_repo
        .list(&coll_id, "count-owner", params)
        .await
        .expect("list");
    crate::common::cleanup_db(&db).await;
    assert_eq!(count, 2, "two Sci-Fi movies");
    assert_eq!(
        count as usize,
        list.items.len(),
        "count must agree with the filtered list length"
    );
}

#[tokio::test]
async fn count_ignores_cursor() {
    let (movie_repo, coll_id, db) = setup().await;
    for t in ["A", "B"] {
        movie_repo
            .create(&coll_id, "count-owner", movie(t, "Sci-Fi"))
            .await
            .expect("seed failed");
    }
    // A cursor that `list` would reject as a 400 — `count` must ignore it (total, not a page).
    let with_cursor = ListMoviesParams {
        cursor: Some("not-a-real-cursor".to_string()),
        ..Default::default()
    };
    let n = movie_repo.count(&coll_id, "count-owner", with_cursor).await;
    crate::common::cleanup_db(&db).await;
    assert_eq!(n.expect("count"), 2);
}
