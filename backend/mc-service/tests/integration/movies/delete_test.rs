/// T085 — Movie adapter integration tests: delete
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::dtos::movie_dto::CreateMovieDto;
use mc_service::application::ports::collection_repository::CollectionRepository;
use mc_service::application::ports::movie_repository::MovieRepository;
use mc_service::domain::errors::DomainError;
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
            "del-owner",
            CreateCollectionDto {
                name: "Delete Test Coll".to_string(),
                description: None,
            },
        )
        .await
        .expect("create coll failed");
    (coll_repo, movie_repo, coll.id, db)
}

fn minimal_movie(title: &str) -> CreateMovieDto {
    CreateMovieDto {
        title: title.to_string(),
        year: 2005,
        content_type: ContentType::Movie,
        language: "English".to_string(),
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
async fn delete_removes_movie() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let created = movie_repo
        .create(&coll_id, "del-owner", minimal_movie("To Delete"))
        .await
        .expect("create failed");

    let del_result = movie_repo.delete(&coll_id, &created.id, "del-owner").await;
    let get_result = movie_repo
        .get_by_id(&coll_id, &created.id, "del-owner")
        .await;
    crate::common::cleanup_db(&db).await;

    del_result.expect("delete should succeed");
    assert!(
        matches!(get_result, Err(DomainError::MovieNotFound)),
        "movie must not be found after deletion"
    );
}

#[tokio::test]
async fn delete_returns_not_found_for_wrong_owner() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let created = movie_repo
        .create(&coll_id, "del-owner", minimal_movie("Private"))
        .await
        .expect("create failed");

    let result = movie_repo.delete(&coll_id, &created.id, "intruder").await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(
            result,
            Err(DomainError::MovieNotFound) | Err(DomainError::CollectionNotFound)
        ),
        "wrong owner must return not-found on delete"
    );
}

#[tokio::test]
async fn delete_returns_not_found_for_nonexistent_id() {
    let (_, movie_repo, coll_id, db) = setup().await;

    let result = movie_repo
        .delete(&coll_id, "000000000000000000000001", "del-owner")
        .await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::MovieNotFound)),
        "nonexistent movie must return MovieNotFound on delete"
    );
}
