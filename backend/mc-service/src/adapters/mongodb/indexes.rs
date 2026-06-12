use mongodb::{
    bson::{doc, Document},
    options::{Collation, CollationStrength, IndexOptions},
    Database, IndexModel,
};

/// Create all required indexes idempotently on startup.
/// Uses `createIndexes` with `{ background: true }` where supported.
/// Each index is named explicitly so the operation is idempotent.
pub async fn create_indexes(db: &Database) -> anyhow::Result<()> {
    create_collection_indexes(db).await?;
    create_movie_indexes(db).await?;
    tracing::info!("MongoDB indexes created/verified");
    Ok(())
}

async fn create_collection_indexes(db: &Database) -> anyhow::Result<()> {
    let coll = db.collection::<Document>("movie_collections");

    // Unique name per owner — case-insensitive via collation
    let unique_name = IndexModel::builder()
        .keys(doc! { "ownerId": 1, "name": 1 })
        .options(
            IndexOptions::builder()
                .unique(true)
                .name("unique_name_per_owner".to_string())
                .collation(
                    Collation::builder()
                        .locale("en".to_string())
                        .strength(CollationStrength::Secondary)
                        .build(),
                )
                .build(),
        )
        .build();

    // Default lookup
    let default_idx = IndexModel::builder()
        .keys(doc! { "ownerId": 1, "isDefault": 1 })
        .options(
            IndexOptions::builder()
                .name("owner_default".to_string())
                .build(),
        )
        .build();

    // Owner listing (cursor-based)
    let owner_list = IndexModel::builder()
        .keys(doc! { "ownerId": 1, "_id": 1 })
        .options(
            IndexOptions::builder()
                .name("owner_id_list".to_string())
                .build(),
        )
        .build();

    coll.create_indexes(vec![unique_name, default_idx, owner_list])
        .await?;
    Ok(())
}

async fn create_movie_indexes(db: &Database) -> anyhow::Result<()> {
    let coll = db.collection::<Document>("movies");

    // Unique movie per collection — case-insensitive title
    let unique_movie = IndexModel::builder()
        .keys(doc! { "collectionId": 1, "title": 1, "year": 1, "contentType": 1 })
        .options(
            IndexOptions::builder()
                .unique(true)
                .name("unique_movie_per_collection".to_string())
                .collation(
                    Collation::builder()
                        .locale("en".to_string())
                        .strength(CollationStrength::Secondary)
                        .build(),
                )
                .build(),
        )
        .build();

    // Cursor pagination
    let cursor_idx = IndexModel::builder()
        .keys(doc! { "collectionId": 1, "_id": 1 })
        .options(
            IndexOptions::builder()
                .name("collection_cursor".to_string())
                .build(),
        )
        .build();

    // Owner access control
    let owner_idx = IndexModel::builder()
        .keys(doc! { "collectionId": 1, "ownerId": 1 })
        .options(
            IndexOptions::builder()
                .name("collection_owner".to_string())
                .build(),
        )
        .build();

    // Article-insensitive title sort + keyset pagination: titleSort↑ then year↑, _id tiebreaker
    // (013 US9 / FR-034). Supersedes sort_title_year for the title path.
    let sort_titlesort_year_idx = IndexModel::builder()
        .keys(doc! { "collectionId": 1, "titleSort": 1, "year": 1, "_id": 1 })
        .options(
            IndexOptions::builder()
                .name("sort_titlesort_year".to_string())
                .build(),
        )
        .build();

    // Drop the legacy $text search index if it exists.
    //
    // We switched from MongoDB $text to $regex for search so that partial-word /
    // substring queries work as users expect.  The text index is no longer used
    // and would otherwise consume write overhead on every insert/update.
    // Ignoring the error is intentional: if the index never existed (fresh
    // deployment) or was already dropped, drop_index returns an error which we
    // swallow — the collection is still usable.
    let _ = coll.drop_index("movie_text_search").await;

    // Filter indexes
    let filter_indexes: Vec<IndexModel> = vec![
        ("year_filter", doc! { "collectionId": 1, "year": 1 }),
        (
            "content_type_filter",
            doc! { "collectionId": 1, "contentType": 1 },
        ),
        ("genre_filter", doc! { "collectionId": 1, "genres": 1 }),
        ("language_filter", doc! { "collectionId": 1, "language": 1 }),
        ("rated_filter", doc! { "collectionId": 1, "rated": 1 }),
        ("owned_filter", doc! { "collectionId": 1, "owned": 1 }),
        (
            "owned_media_filter",
            doc! { "collectionId": 1, "ownedMedia": 1 },
        ),
        ("ripped_filter", doc! { "collectionId": 1, "ripped": 1 }),
        (
            "rip_quality_filter",
            doc! { "collectionId": 1, "ripQuality": 1 },
        ),
        (
            "childrens_filter",
            doc! { "collectionId": 1, "childrens": 1 },
        ),
    ]
    .into_iter()
    .map(|(name, keys)| {
        IndexModel::builder()
            .keys(keys)
            .options(IndexOptions::builder().name(name.to_string()).build())
            .build()
    })
    .collect();

    // Drop the superseded raw-title sort index if it exists (013 US9 replaces it with titleSort).
    let _ = coll.drop_index("sort_title_year").await;

    let mut all_indexes = vec![unique_movie, cursor_idx, owner_idx, sort_titlesort_year_idx];
    all_indexes.extend(filter_indexes);

    coll.create_indexes(all_indexes).await?;

    backfill_title_sort(&coll).await?;
    Ok(())
}

/// 013 US9 backfill: populate `titleSort` for any documents missing it (pre-feature data) so the
/// `sort_titlesort_year` index is fully covered. Idempotent — only touches documents where the
/// field is absent. Runs once per startup; a no-op once every document has the key.
async fn backfill_title_sort(coll: &mongodb::Collection<Document>) -> anyhow::Result<()> {
    use futures::TryStreamExt;

    let missing = doc! { "titleSort": { "$exists": false } };
    let mut cursor = coll
        .find(missing.clone())
        .projection(doc! { "_id": 1, "title": 1 })
        .await?;

    let mut updated = 0u64;
    while let Some(d) = cursor.try_next().await? {
        let Some(id) = d.get_object_id("_id").ok() else {
            continue;
        };
        let title = d.get_str("title").unwrap_or("");
        let key = super::movie_repository::title_sort_key(title);
        coll.update_one(doc! { "_id": id }, doc! { "$set": { "titleSort": key } })
            .await?;
        updated += 1;
    }
    if updated > 0 {
        tracing::info!(count = updated, "Backfilled titleSort on existing movies");
    }
    Ok(())
}
