/// T085 — Movie adapter integration tests: full replacement update
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::dtos::movie_dto::{CreateMovieDto, UpdateMovieDto};
use mc_service::application::ports::collection_repository::CollectionRepository;
use mc_service::application::ports::movie_repository::MovieRepository;
use mc_service::domain::errors::DomainError;
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
            "upd-owner",
            CreateCollectionDto {
                name: "Update Test Coll".to_string(),
                description: None,
            },
        )
        .await
        .expect("create coll failed");
    (coll_repo, movie_repo, coll.id, db)
}

fn base_create_dto(title: &str) -> CreateMovieDto {
    CreateMovieDto {
        title: title.to_string(),
        year: 2001,
        content_type: ContentType::Movie,
        language: Some("English".to_string()),
        owned: false,
        ripped: false,
        childrens: false,
        owned_media: vec![],
        rip_quality: vec![],
        genres: vec!["Action".to_string()],
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

fn base_update_dto(title: &str) -> UpdateMovieDto {
    UpdateMovieDto {
        title: title.to_string(),
        year: 2001,
        content_type: ContentType::Movie,
        language: Some("English".to_string()),
        owned: false,
        ripped: false,
        childrens: false,
        owned_media: vec![],
        rip_quality: vec![],
        genres: vec!["Action".to_string()],
        rated: Some(UsaRating::PG13),
        directors: vec!["New Director".to_string()],
        actors: vec![],
        tags: vec![],
        movie_set: None,
        original_title: None,
        release_date: None,
        outline: Some("Updated outline".to_string()),
        plot: None,
        runtime: Some(120),
        external_ids: vec![],
    }
}

#[tokio::test]
async fn update_full_replacement_succeeds() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let created = movie_repo
        .create(&coll_id, "upd-owner", base_create_dto("Original"))
        .await
        .expect("create failed");

    let update = base_update_dto("Updated");
    let result = movie_repo
        .update(&coll_id, &created.id, "upd-owner", update)
        .await;
    crate::common::cleanup_db(&db).await;

    let updated = result.expect("update should succeed");
    assert_eq!(updated.title, "Updated");
    assert_eq!(updated.outline, Some("Updated outline".to_string()));
    assert_eq!(updated.runtime, Some(120));
}

#[tokio::test]
async fn update_rejects_duplicate_title_year_content_type() {
    let (_, movie_repo, coll_id, db) = setup().await;

    movie_repo
        .create(&coll_id, "upd-owner", base_create_dto("Movie A"))
        .await
        .expect("create first failed");
    let second = movie_repo
        .create(&coll_id, "upd-owner", base_create_dto("Movie B"))
        .await
        .expect("create second failed");

    // Try to rename second to same as first — should be rejected
    let mut update = base_update_dto("Movie A");
    update.year = 2001; // same year
    let result = movie_repo
        .update(&coll_id, &second.id, "upd-owner", update)
        .await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::DuplicateMovie)),
        "updating to duplicate title+year+contentType must return DuplicateMovie"
    );
}

/// 009 #5 — editing a movie must preserve its original createdAt.
#[tokio::test]
async fn update_preserves_created_at() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let created = movie_repo
        .create(&coll_id, "upd-owner", base_create_dto("Original"))
        .await
        .expect("create failed");
    let original_created_at = created.created_at.clone();

    // Advance wall-clock so a (buggy) createdAt overwrite would be detectable.
    std::thread::sleep(std::time::Duration::from_millis(50));

    let result = movie_repo
        .update(
            &coll_id,
            &created.id,
            "upd-owner",
            base_update_dto("Updated"),
        )
        .await;
    crate::common::cleanup_db(&db).await;

    let updated = result.expect("update should succeed");
    assert_eq!(
        updated.created_at, original_created_at,
        "createdAt must be preserved across edits (009 #5)"
    );
    assert_ne!(
        updated.updated_at, original_created_at,
        "updatedAt should advance past the original creation time"
    );
}

#[tokio::test]
async fn update_returns_movie_not_found_for_nonexistent_id() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let result = movie_repo
        .update(
            &coll_id,
            "000000000000000000000001",
            "upd-owner",
            base_update_dto("X"),
        )
        .await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::MovieNotFound)),
        "nonexistent movie must return MovieNotFound on update"
    );
}
