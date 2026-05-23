use mc_service::config::Config;
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

    // Build the Axum router with all routes registered
    let app = mc_service::api::router::build(db, &config).await?;

    // Bind and serve
    let addr = format!("0.0.0.0:{}", config.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(addr = %addr, "mc-service listening");

    axum::serve(listener, app).await?;

    Ok(())
}
