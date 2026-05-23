use serde::{Deserialize, Serialize};

/// An external identifier linking a movie to an external database system.
///
/// Serialized to camelCase JSON: `uniqueId` per the mc-service API contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalIdentifier {
    /// The name of the external system, e.g. "IMDB", "TMDB"
    pub system: String,
    /// The unique identifier within the external system. Serialized as `uniqueId`.
    pub unique_id: String,
    /// Optional URL to the movie in that system
    pub url: Option<String>,
}

impl ExternalIdentifier {
    /// Create a new external identifier.
    ///
    /// # Errors
    /// Returns `Err` if `system` or `unique_id` is empty.
    pub fn new(
        system: impl Into<String>,
        unique_id: impl Into<String>,
        url: Option<String>,
    ) -> Result<Self, String> {
        let system = system.into();
        let unique_id = unique_id.into();

        if system.trim().is_empty() {
            return Err("External identifier system must not be empty".to_string());
        }
        if unique_id.trim().is_empty() {
            return Err("External identifier unique_id must not be empty".to_string());
        }

        Ok(Self {
            system,
            unique_id,
            url,
        })
    }

    /// Returns a tuple `(system, unique_id)` for uniqueness comparison.
    pub fn key(&self) -> (&str, &str) {
        (&self.system, &self.unique_id)
    }
}

/// Check whether a list of ExternalIdentifiers contains any duplicate (system, unique_id) pairs.
pub fn has_duplicate_external_ids(ids: &[ExternalIdentifier]) -> bool {
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id.key()) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    // T070a

    #[test]
    fn valid_external_identifier_construction() {
        let id = ExternalIdentifier::new("IMDB", "tt1234567", None).unwrap();
        assert_eq!(id.system, "IMDB");
        assert_eq!(id.unique_id, "tt1234567");
        assert_eq!(id.url, None);
    }

    #[test]
    fn external_identifier_with_url() {
        let url = Some("https://www.imdb.com/title/tt1234567/".to_string());
        let id = ExternalIdentifier::new("IMDB", "tt1234567", url.clone()).unwrap();
        assert_eq!(id.url, url);
    }

    #[test]
    fn rejects_empty_system() {
        let result = ExternalIdentifier::new("", "tt123", None);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_empty_unique_id() {
        let result = ExternalIdentifier::new("IMDB", "", None);
        assert!(result.is_err());
    }

    #[test]
    fn duplicate_detection_finds_same_system_and_unique_id() {
        let ids = vec![
            ExternalIdentifier::new("IMDB", "tt123", None).unwrap(),
            ExternalIdentifier::new("IMDB", "tt123", None).unwrap(),
        ];
        assert!(has_duplicate_external_ids(&ids));
    }

    #[test]
    fn duplicate_detection_allows_same_system_different_id() {
        let ids = vec![
            ExternalIdentifier::new("IMDB", "tt111", None).unwrap(),
            ExternalIdentifier::new("IMDB", "tt222", None).unwrap(),
        ];
        assert!(!has_duplicate_external_ids(&ids));
    }

    #[test]
    fn duplicate_detection_allows_different_system_same_id() {
        let ids = vec![
            ExternalIdentifier::new("IMDB", "tt123", None).unwrap(),
            ExternalIdentifier::new("TMDB", "tt123", None).unwrap(),
        ];
        assert!(!has_duplicate_external_ids(&ids));
    }
}
