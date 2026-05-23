use mongodb::{Client, Database};

/// Connect to MongoDB and return a handle to the `mc_db` database.
///
/// Parses the database name from the URL path (e.g. `mongodb://host/mc_db`).
/// Falls back to `mc_db` if no path is present.
///
/// # Errors
/// Returns an error if the connection string is invalid or the server is unreachable.
pub async fn connect(db_url: &str) -> anyhow::Result<Database> {
    let client = Client::with_uri_str(db_url).await?;

    // Extract database name from URL path component
    let db_name = db_url
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("mc_db");

    let db = client.database(db_name);

    // Ping to verify connectivity
    db.run_command(bson::doc! { "ping": 1 }).await?;

    tracing::info!(db = db_name, "Connected to MongoDB");
    Ok(db)
}
