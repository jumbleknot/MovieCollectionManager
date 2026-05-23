/// T039 — Adapter integration tests: update (rename + duplicate rejection)
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::application::dtos::collection_dto::{CreateCollectionDto, UpdateCollectionDto};
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
async fn update_rename_succeeds() {
    let (repo, db) = repo().await;

    let created = repo
        .create(
            "owner-upd",
            CreateCollectionDto {
                name: "Old Name".to_string(),
                description: None,
            },
        )
        .await
        .expect("create failed");

    let update = UpdateCollectionDto {
        name: Some("New Name".to_string()),
        description: None,
        is_default: None,
    };
    let result = repo.update(&created.id, "owner-upd", update).await;
    crate::common::cleanup_db(&db).await;

    let updated = result.expect("update should succeed");
    assert_eq!(updated.name, "New Name");
}

#[tokio::test]
async fn update_rejects_duplicate_name_case_insensitive() {
    let (repo, db) = repo().await;

    repo.create(
        "owner-dup",
        CreateCollectionDto {
            name: "Action".to_string(),
            description: None,
        },
    )
    .await
    .expect("create first failed");

    let second = repo
        .create(
            "owner-dup",
            CreateCollectionDto {
                name: "Drama".to_string(),
                description: None,
            },
        )
        .await
        .expect("create second failed");

    let update = UpdateCollectionDto {
        name: Some("ACTION".to_string()), // case-insensitive duplicate
        description: None,
        is_default: None,
    };
    let result = repo.update(&second.id, "owner-dup", update).await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::DuplicateCollectionName)),
        "renaming to existing name (case-insensitive) must return DuplicateCollectionName"
    );
}

#[tokio::test]
async fn update_partial_only_changes_provided_fields() {
    let (repo, db) = repo().await;

    let created = repo
        .create(
            "owner-part",
            CreateCollectionDto {
                name: "Original".to_string(),
                description: Some("Original desc".to_string()),
            },
        )
        .await
        .expect("create failed");

    // Update only description — name must remain unchanged
    // description: Some(Some("text")) means "set description to 'text'"
    // description: None means "leave description unchanged"
    let update = UpdateCollectionDto {
        name: None,
        description: Some(Some("Updated desc".to_string())),
        is_default: None,
    };
    let result = repo.update(&created.id, "owner-part", update).await;
    crate::common::cleanup_db(&db).await;

    let updated = result.expect("partial update should succeed");
    assert_eq!(
        updated.name, "Original",
        "name must not change in partial update"
    );
    assert_eq!(updated.description, Some("Updated desc".to_string()));
}

#[tokio::test]
async fn update_returns_not_found_for_wrong_owner() {
    let (repo, db) = repo().await;

    let created = repo
        .create(
            "real-owner-upd",
            CreateCollectionDto {
                name: "Mine".to_string(),
                description: None,
            },
        )
        .await
        .expect("create failed");

    let update = UpdateCollectionDto {
        name: Some("Hijacked".to_string()),
        description: None,
        is_default: None,
    };
    let result = repo.update(&created.id, "attacker", update).await;
    crate::common::cleanup_db(&db).await;

    assert!(
        matches!(result, Err(DomainError::CollectionNotFound)),
        "wrong owner must return CollectionNotFound on update"
    );
}
