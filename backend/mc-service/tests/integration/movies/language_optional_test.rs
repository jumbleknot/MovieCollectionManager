/// 014 US1 (T011) — optional `language` adapter integration tests (real Mongo).
/// A movie can be created with no language; reads return it as `None`; the
/// filter-options language facet excludes the absent value (US1-AC1, US1-AC3).
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::dtos::movie_dto::CreateMovieDto;
use mc_service::application::ports::collection_repository::CollectionRepository;
use mc_service::application::ports::movie_repository::{ListMoviesParams, MovieRepository};
use mc_service::domain::movie::ContentType;

async fn repos() -> (MongoMovieRepository, String, mongodb::Database) {
    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");

    let coll_repo = MongoCollectionRepository::new(&db);
    let movie_repo = MongoMovieRepository::new(&db);

    let coll = coll_repo
        .create(
            "lang-owner",
            CreateCollectionDto {
                name: "Language Optional Collection".to_string(),
                description: None,
            },
        )
        .await
        .expect("test collection create failed");

    (movie_repo, coll.id, db)
}

fn movie_without_language(title: &str) -> CreateMovieDto {
    CreateMovieDto {
        title: title.to_string(),
        year: 2024,
        content_type: ContentType::Movie,
        language: None,
        owned: false,
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

#[tokio::test]
async fn create_movie_with_no_language_optional_persists_and_reads_back_none() {
    let (movie_repo, coll_id, db) = repos().await;

    let created = movie_repo
        .create(&coll_id, "lang-owner", movie_without_language("No Language Film"))
        .await
        .expect("create with no language must succeed");
    assert_eq!(created.language, None, "created movie language must be None");

    let fetched = movie_repo
        .get_by_id(&coll_id, &created.id, "lang-owner")
        .await
        .expect("get_by_id must succeed");
    crate::common::cleanup_db(&db).await;

    assert_eq!(fetched.language, None, "persisted movie language must read back as None");
}

#[tokio::test]
async fn filter_options_language_optional_excludes_absent_language() {
    let (movie_repo, coll_id, db) = repos().await;

    // One movie with a language, one without.
    let mut with_lang = movie_without_language("Has Language");
    with_lang.language = Some("English".to_string());
    movie_repo
        .create(&coll_id, "lang-owner", with_lang)
        .await
        .expect("create with language must succeed");
    movie_repo
        .create(&coll_id, "lang-owner", movie_without_language("Lacks Language"))
        .await
        .expect("create without language must succeed");

    let opts = movie_repo
        .get_filter_options(&coll_id, "lang-owner")
        .await
        .expect("filter options must succeed");
    crate::common::cleanup_db(&db).await;

    assert!(
        opts.languages.contains(&"English".to_string()),
        "the present language must appear in the facet"
    );
    assert!(
        !opts.languages.iter().any(|l| l.is_empty()),
        "the language facet must not contain a blank/empty entry (US1-AC3)"
    );
    assert_eq!(
        opts.languages.len(),
        1,
        "only the one present language should appear; the absent one is excluded"
    );
}

#[tokio::test]
async fn list_movies_language_optional_returns_movie_with_none_language() {
    let (movie_repo, coll_id, db) = repos().await;

    movie_repo
        .create(&coll_id, "lang-owner", movie_without_language("Listed No Language"))
        .await
        .expect("create must succeed");

    let listed = movie_repo
        .list(&coll_id, "lang-owner", ListMoviesParams::default())
        .await
        .expect("list must succeed");
    crate::common::cleanup_db(&db).await;

    let found = listed
        .items
        .iter()
        .find(|m| m.title == "Listed No Language")
        .expect("the language-less movie must be listed");
    assert_eq!(found.language, None);
}
