/// T039 — Adapter integration tests: list_by_owner
use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
use mc_service::application::dtos::collection_dto::CreateCollectionDto;
use mc_service::application::ports::collection_repository::CollectionRepository;

async fn repo() -> (MongoCollectionRepository, mongodb::Database) {
    let db = crate::common::test_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");
    (MongoCollectionRepository::new(&db), db)
}

#[tokio::test]
async fn list_returns_empty_for_new_owner() {
    let (repo, db) = repo().await;
    let result = repo.list_by_owner("brand-new-owner").await;
    crate::common::cleanup_db(&db).await;

    let list = result.expect("list should not error for empty owner");
    assert!(list.is_empty(), "new owner should have 0 collections");
}

#[tokio::test]
async fn list_returns_only_owner_collections() {
    let (repo, db) = repo().await;

    for i in 1..=2 {
        repo.create(
            "owner-A",
            CreateCollectionDto {
                name: format!("A-Collection-{}", i),
                description: None,
            },
        )
        .await
        .expect("create failed");
    }
    repo.create(
        "owner-B",
        CreateCollectionDto {
            name: "B-Collection".to_string(),
            description: None,
        },
    )
    .await
    .expect("create failed");

    let result_a = repo.list_by_owner("owner-A").await;
    let result_b = repo.list_by_owner("owner-B").await;
    crate::common::cleanup_db(&db).await;

    let list_a = result_a.expect("list for owner-A failed");
    let list_b = result_b.expect("list for owner-B failed");

    assert_eq!(list_a.len(), 2, "owner-A should have 2 collections");
    assert_eq!(list_b.len(), 1, "owner-B should have 1 collection");
    assert!(list_a.iter().all(|c| c.name.starts_with("A-")));
}

#[tokio::test]
async fn list_includes_movie_count_zero_for_empty_collection() {
    let (repo, db) = repo().await;
    repo.create(
        "owner-count",
        CreateCollectionDto {
            name: "Empty Coll".to_string(),
            description: None,
        },
    )
    .await
    .expect("create failed");

    let result = repo.list_by_owner("owner-count").await;
    crate::common::cleanup_db(&db).await;

    let list = result.expect("list failed");
    assert_eq!(
        list[0].movie_count, 0,
        "empty collection must have movie_count = 0"
    );
}
