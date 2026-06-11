//! 013 US1 — server-applied sort + compound keyset pagination against real Mongo.
//! Proves the list is globally ordered by the requested sort, pagination across page
//! boundaries neither duplicates nor skips a document, and sort composes with the filter.
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
            "sort-owner",
            CreateCollectionDto {
                name: "Sort Test Coll".to_string(),
                description: None,
            },
        )
        .await
        .expect("create coll failed");
    (movie_repo, coll.id, db)
}

fn movie(title: &str, year: i32, owned: bool) -> CreateMovieDto {
    CreateMovieDto {
        title: title.to_string(),
        year,
        content_type: ContentType::Movie,
        language: "English".to_string(),
        owned,
        ripped: false,
        childrens: false,
        owned_media: vec![],
        rip_quality: vec![],
        genres: vec![],
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

fn params(sort_by: &str, sort_dir: &str) -> ListMoviesParams {
    ListMoviesParams {
        sort_by: Some(sort_by.to_string()),
        sort_dir: Some(sort_dir.to_string()),
        ..Default::default()
    }
}

/// Default (no sort params) orders by title↑, ties broken by year↑.
#[tokio::test]
async fn default_sort_is_title_then_year() {
    let (repo, coll_id, db) = setup().await;
    // Insert out of order; two share the title "Alpha" with different years.
    for (t, y) in [("Charlie", 2001), ("Alpha", 2010), ("Alpha", 1999), ("Bravo", 2005)] {
        repo.create(&coll_id, "sort-owner", movie(t, y, false))
            .await
            .expect("seed");
    }
    let list = repo
        .list(&coll_id, "sort-owner", ListMoviesParams::default())
        .await
        .expect("list");
    crate::common::cleanup_db(&db).await;
    let got: Vec<(String, i32)> = list.items.iter().map(|m| (m.title.clone(), m.year)).collect();
    assert_eq!(
        got,
        vec![
            ("Alpha".to_string(), 1999),
            ("Alpha".to_string(), 2010),
            ("Bravo".to_string(), 2005),
            ("Charlie".to_string(), 2001),
        ]
    );
}

/// A descending sort reverses the order.
#[tokio::test]
async fn year_desc_orders_high_to_low() {
    let (repo, coll_id, db) = setup().await;
    for (t, y) in [("A", 2001), ("B", 2010), ("C", 1999)] {
        repo.create(&coll_id, "sort-owner", movie(t, y, false))
            .await
            .expect("seed");
    }
    let list = repo
        .list(&coll_id, "sort-owner", params("year", "desc"))
        .await
        .expect("list");
    crate::common::cleanup_db(&db).await;
    let years: Vec<i32> = list.items.iter().map(|m| m.year).collect();
    assert_eq!(years, vec![2010, 2001, 1999]);
}

/// Full pagination under a non-default sort visits every document exactly once, in order.
#[tokio::test]
async fn paginates_in_sort_order_without_dup_or_skip() {
    let (repo, coll_id, db) = setup().await;
    // 51 movies forces a second page (batch size 50). Reverse-padded titles so insertion
    // order differs from sorted order, exercising the keyset boundary.
    for i in 1..=51u32 {
        let t = format!("Title {:03}", 52 - i);
        repo.create(&coll_id, "sort-owner", movie(&t, 2000, false))
            .await
            .expect("seed");
    }
    let mut seen: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let p = ListMoviesParams {
            cursor: cursor.clone(),
            sort_by: Some("title".to_string()),
            sort_dir: Some("asc".to_string()),
            ..Default::default()
        };
        let page = repo.list(&coll_id, "sort-owner", p).await.expect("page");
        seen.extend(page.items.iter().map(|m| m.title.clone()));
        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    crate::common::cleanup_db(&db).await;
    assert_eq!(seen.len(), 51, "every movie visited exactly once");
    let mut sorted = seen.clone();
    sorted.sort();
    assert_eq!(seen, sorted, "pages arrive in global title order");
    sorted.dedup();
    assert_eq!(sorted.len(), 51, "no duplicates across page boundaries");
}

/// Sort composes with the filter: only the filtered subset is returned, in sort order.
#[tokio::test]
async fn sort_applies_to_filtered_subset() {
    let (repo, coll_id, db) = setup().await;
    for (t, y, owned) in [
        ("Zed", 2001, true),
        ("Apple", 2003, true),
        ("Mango", 2002, false),
    ] {
        repo.create(&coll_id, "sort-owner", movie(t, y, owned))
            .await
            .expect("seed");
    }
    let p = ListMoviesParams {
        owned: Some(true),
        sort_by: Some("title".to_string()),
        sort_dir: Some("asc".to_string()),
        ..Default::default()
    };
    let list = repo.list(&coll_id, "sort-owner", p).await.expect("list");
    crate::common::cleanup_db(&db).await;
    let titles: Vec<String> = list.items.iter().map(|m| m.title.clone()).collect();
    assert_eq!(titles, vec!["Apple".to_string(), "Zed".to_string()]);
}

/// A cursor minted under one sort is rejected (400 / ValidationError) when the sort changes.
#[tokio::test]
async fn cursor_minted_under_different_sort_is_rejected() {
    let (repo, coll_id, db) = setup().await;
    for i in 1..=51u32 {
        repo.create(&coll_id, "sort-owner", movie(&format!("M {:03}", i), 2000, false))
            .await
            .expect("seed");
    }
    let first = repo
        .list(&coll_id, "sort-owner", params("title", "asc"))
        .await
        .expect("first page");
    let cursor = first.next_cursor.expect("cursor present");
    // Re-use that title-asc cursor but request year-desc → must be rejected, not silently restarted.
    let mismatched = ListMoviesParams {
        cursor: Some(cursor),
        sort_by: Some("year".to_string()),
        sort_dir: Some("desc".to_string()),
        ..Default::default()
    };
    let res = repo.list(&coll_id, "sort-owner", mismatched).await;
    crate::common::cleanup_db(&db).await;
    assert!(res.is_err(), "mismatched-sort cursor must be rejected");
}
