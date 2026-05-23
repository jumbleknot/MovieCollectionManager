/// Application configuration loaded from environment variables.
/// All required vars cause a startup failure (fail-fast) when missing or invalid.
#[derive(Debug, Clone)]
pub struct Config {
    /// MongoDB connection string, e.g. `mongodb://localhost:27017/mc_db`
    pub db_url: String,
    /// Base URL of the Keycloak server, e.g. `http://localhost:8099`
    pub keycloak_url: String,
    /// Keycloak realm name
    pub keycloak_realm: String,
    /// OAuth2 client ID registered in Keycloak
    pub keycloak_client_id: String,
    /// TCP port this service listens on
    pub port: u16,
}

impl Config {
    /// Load configuration from environment variables.
    /// Loads `.env.local` then `.env` if present (via dotenvy), then reads process env.
    ///
    /// # Errors
    /// Returns an error if any required variable is missing or PORT is not a valid u16.
    pub fn from_env() -> Result<Self, ConfigError> {
        // Load .env.local override first, then .env fallback (both optional)
        let _ = dotenvy::from_filename(".env.local");
        let _ = dotenvy::dotenv();

        let db_url = require_env("MC_DB_URL")?;
        let keycloak_url = require_env("KEYCLOAK_URL")?;
        let keycloak_realm = require_env("KEYCLOAK_REALM")?;
        let keycloak_client_id = require_env("KEYCLOAK_CLIENT_ID")?;
        let port = require_env("MC_SERVICE_PORT")?
            .parse::<u16>()
            .map_err(|_| ConfigError::InvalidPort)?;

        Ok(Self {
            db_url,
            keycloak_url,
            keycloak_realm,
            keycloak_client_id,
            port,
        })
    }
}

fn require_env(key: &str) -> Result<String, ConfigError> {
    std::env::var(key).map_err(|_| ConfigError::Missing(key.to_string()))
}

/// Errors that can occur when loading configuration.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("Missing required environment variable: {0}")]
    Missing(String),
    #[error("MC_SERVICE_PORT must be a valid port number (1–65535)")]
    InvalidPort,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn require_env_returns_error_when_missing() {
        // Use a key guaranteed not to exist
        let result = require_env("MC_SERVICE_TEST_NONEXISTENT_12345");
        assert!(result.is_err());
        match result {
            Err(ConfigError::Missing(key)) => assert_eq!(key, "MC_SERVICE_TEST_NONEXISTENT_12345"),
            _ => panic!("Expected Missing error"),
        }
    }

    #[test]
    fn require_env_returns_value_when_set() {
        std::env::set_var("MC_SERVICE_TEST_KEY", "test_value");
        let result = require_env("MC_SERVICE_TEST_KEY");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "test_value");
        std::env::remove_var("MC_SERVICE_TEST_KEY");
    }

    #[test]
    fn config_error_missing_displays_var_name() {
        let err = ConfigError::Missing("MY_VAR".to_string());
        assert!(err.to_string().contains("MY_VAR"));
    }

    #[test]
    fn config_error_invalid_port_displays_port_hint() {
        let err = ConfigError::InvalidPort;
        assert!(err.to_string().contains("port") || err.to_string().contains("PORT"));
    }
}
