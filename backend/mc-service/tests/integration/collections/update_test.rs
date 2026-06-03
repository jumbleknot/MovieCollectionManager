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

/// 009 #6 — a failed/foreign set-default must NOT clear the user's existing default.
#[tokio::test]
async fn set_default_foreign_target_keeps_existing_default() {
    use mc_service::application::commands::set_default_collection::{
        SetDefaultCollectionCommand, SetDefaultCollectionHandler,
    };
    use std::sync::Arc;

    let (repo, db) = repo().await;
    let existing = repo
        .create(
            "sd-owner",
            CreateCollectionDto {
                name: "Mine".to_string(),
                description: None,
            },
        )
        .await
        .expect("create failed");

    let handler = SetDefaultCollectionHandler::new(Arc::new(MongoCollectionRepository::new(&db)));

    // Valid set-default establishes the existing default.
    handler
        .handle(SetDefaultCollectionCommand {
            collection_id: existing.id.clone(),
            owner_id: "sd-owner".to_string(),
        })
        .await
        .expect("initial set-default should succeed");

    // Set-default on a non-existent target must fail WITHOUT clearing the default.
    let result = handler
        .handle(SetDefaultCollectionCommand {
            collection_id: "000000000000000000000009".to_string(),
            owner_id: "sd-owner".to_string(),
        })
        .await;

    let default_after = repo
        .find_default_for_owner("sd-owner")
        .await
        .expect("find_default_for_owner failed");
    crate::common::cleanup_db(&db).await;

    assert!(matches!(result, Err(DomainError::CollectionNotFound)));
    let default_after = default_after.expect("existing default must be retained");
    assert_eq!(
        default_after.id, existing.id,
        "the original default must remain after a failed set-default (009 #6)"
    );
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
