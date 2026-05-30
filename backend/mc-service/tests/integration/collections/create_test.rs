/// T039 — Adapter integration tests: collection create + duplicate rejection
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
async fn create_returns_dto_with_generated_id() {
    let (repo, db) = repo().await;

    let dto = CreateCollectionDto {
        name: "My Movies".to_string(),
        description: Some("Test collection".to_string()),
    };
    let result = repo.create("owner-123", dto).await;
    crate::common::cleanup_db(&db).await;

    let created = result.expect("create should succeed");
    assert!(!created.id.is_empty(), "id must be set");
    assert_eq!(created.name, "My Movies");
    assert_eq!(created.description, Some("Test collection".to_string()));
    assert!(!created.is_default);
    assert_eq!(created.owner_id, "owner-123");
}

#[tokio::test]
async fn create_rejects_duplicate_name_same_owner_case_insensitive() {
    let (repo, db) = repo().await;

    repo.create(
        "owner-abc",
        CreateCollectionDto {
            name: "Sci-Fi".to_string(),
            description: None,
        },
    )
    .await
    .expect("first create should succeed");

    let result = repo
        .create(
            "owner-abc",
            CreateCollectionDto {
                name: "sci-fi".to_string(), // different case, same logical name
                description: None,
            },
        )
        .await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::DuplicateCollectionName)),
        "duplicate name (case-insensitive) must return DuplicateCollectionName"
    );
}

#[tokio::test]
async fn create_allows_same_name_different_owner() {
    let (repo, db) = repo().await;

    let r1 = repo
        .create(
            "owner-1",
            CreateCollectionDto {
                name: "Shared Name".to_string(),
                description: None,
            },
        )
        .await;
    let r2 = repo
        .create(
            "owner-2",
            CreateCollectionDto {
                name: "Shared Name".to_string(),
                description: None,
            },
        )
        .await;
    crate::common::cleanup_db(&db).await;

    r1.expect("owner-1 create should succeed");
    r2.expect("owner-2 create with same name should succeed (different owner)");
}

#[tokio::test]
async fn create_sets_is_default_false_for_first_collection() {
    let (repo, db) = repo().await;
    let result = repo
        .create(
            "owner-new",
            CreateCollectionDto {
                name: "First".to_string(),
                description: None,
            },
        )
        .await;
    crate::common::cleanup_db(&db).await;

    let created = result.expect("create should succeed");
    assert!(
        !created.is_default,
        "first collection must not be default automatically"
    );
}
