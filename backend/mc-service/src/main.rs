use mc_service::config::Config;
use mongodb::Database;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize structured JSON tracing
    tracing_subscriber::registry()
        .with(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "mc_service=info".parse().unwrap()),
        )
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    // Load and validate configuration
    let config = Config::from_env()?;

    tracing::info!(port = config.port, "Starting mc-service");

    // Connect to MongoDB
    let db = mc_service::adapters::mongodb::client::connect(&config.db_url).await?;

    // Create all indexes on startup
    mc_service::adapters::mongodb::indexes::create_indexes(&db).await?;

    // Warn about any orphaned movie records left by a partial delete (e.g. a
    // crash between collection removal and movie cascade before transactions
    // were added — T166).  These records are harmless to service operation but
    // consume storage and skew counts; manual cleanup may be desirable.
    check_orphaned_movies(&db).await;

    // Build the Axum router with all routes registered
    let app = mc_service::api::router::build(db, &config).await?;

    // Bind and serve
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(addr = %addr, "mc-service listening");

    axum::serve(listener, app).await?;

    Ok(())
}

/// Runs a $lookup aggregate to count movies whose parent collection no longer
/// exists.  Only emits a warning; never modifies data.
async fn check_orphaned_movies(db: &Database) {
    use bson::doc;
    use futures::TryStreamExt;

    let pipeline = vec![
        doc! { "$lookup": {
            "from": "movie_collections",
            "localField": "collectionId",
            "foreignField": "_id",
            "as": "parentCollection"
        }},
        doc! { "$match": { "parentCollection": { "$size": 0 } } },
        doc! { "$count": "orphanCount" },
    ];

    let movies: mongodb::Collection<bson::Document> = db.collection("movies");
    match movies.aggregate(pipeline).await {
        Err(e) => {
            tracing::warn!(error = %e, "Orphan check aggregate failed — skipping");
        }
        Ok(mut cursor) => {
            let count: i64 = match cursor.try_next().await {
                Ok(Some(doc)) => doc.get_i32("orphanCount").unwrap_or(0) as i64,
                Ok(None) => 0,
                Err(e) => {
                    tracing::warn!(error = %e, "Orphan check cursor error — skipping");
                    return;
                }
            };
            if count > 0 {
                tracing::warn!(
                    orphan_count = count,
                    "Orphaned movie records detected: movies whose parent collection \
                     is missing. These may be remnants of a pre-transaction partial \
                     delete (T166). Manual cleanup may be required."
                );
            } else {
                tracing::info!("Orphan check: no orphaned movie records found");
            }
        }
    }
}
