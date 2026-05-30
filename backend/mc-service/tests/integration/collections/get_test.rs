/// T039 — Adapter integration tests: get_by_id
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::ports::collection_repository::CollectionRepository;
use mc_service::domain::errors::DomainError;

async fn repo() -> (MongoCollectionRepository, mongodb::Database) {
    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");
    (MongoCollectionRepository::new(&db), db)
}

#[tokio::test]
async fn get_by_id_returns_collection_for_owner() {
    let (repo, db) = repo().await;

    let created = repo
        .create(
            "owner-get",
            CreateCollectionDto {
                name: "Get Me".to_string(),
                description: Some("desc".to_string()),
            },
        )
        .await
        .expect("create failed");

    let result = repo.get_by_id(&created.id, "owner-get").await;
    crate::common::cleanup_db(&db).await;

    let got = result.expect("get_by_id should return the collection");
    assert_eq!(got.id, created.id);
    assert_eq!(got.name, "Get Me");
}

#[tokio::test]
async fn get_by_id_returns_not_found_for_wrong_owner() {
    let (repo, db) = repo().await;

    let created = repo
        .create(
            "real-owner",
            CreateCollectionDto {
                name: "Private".to_string(),
                description: None,
            },
        )
        .await
        .expect("create failed");

    let result = repo.get_by_id(&created.id, "other-owner").await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::CollectionNotFound)),
        "wrong owner must return CollectionNotFound"
    );
}

#[tokio::test]
async fn get_by_id_returns_not_found_for_nonexistent_id() {
    let (repo, db) = repo().await;
    let result = repo
        .get_by_id("000000000000000000000001", "any-owner")
        .await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::CollectionNotFound)),
        "nonexistent id must return CollectionNotFound"
    );
}
