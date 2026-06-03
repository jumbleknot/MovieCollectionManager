use super::spec::Specification;
use crate::domain::errors::DomainError;
use crate::domain::external_id::{has_duplicate_external_ids, ExternalIdentifier};

/// A URL is acceptable only when its scheme is `http` or `https`.
///
/// Enforced so that attacker-controlled external-identifier URLs (e.g.
/// `javascript:`, `data:`, `file:`) can never be persisted as tappable links
/// and later executed in the client (009 finding #1).
pub struct HttpUrlSpec;

impl Specification<str> for HttpUrlSpec {
    fn is_satisfied_by(&self, candidate: &str) -> bool {
        let lower = candidate.trim().to_ascii_lowercase();
        lower.starts_with("http://") || lower.starts_with("https://")
    }
}

/// Validate a movie's external identifiers on the create/update path.
///
/// Serde `Deserialize` on `ExternalIdentifier` bypasses its constructor, so the
/// non-empty, scheme, and duplicate checks must be invoked explicitly here
/// (FR-001/FR-002). Returns a `ValidationError` (→ 400) on the first violation.
pub fn validate_external_ids(ids: &[ExternalIdentifier]) -> Result<(), DomainError> {
    for eid in ids {
        if eid.system.trim().is_empty() || eid.unique_id.trim().is_empty() {
            return Err(DomainError::ValidationError(
                "External identifier system and uniqueId must not be empty".to_string(),
            ));
        }
        if let Some(url) = &eid.url {
            if !HttpUrlSpec.is_satisfied_by(url) {
                return Err(DomainError::ValidationError(
                    "External identifier url must use the http or https scheme".to_string(),
                ));
            }
        }
    }
    if has_duplicate_external_ids(ids) {
        return Err(DomainError::ValidationError(
            "Duplicate external identifiers (same system and uniqueId) are not allowed".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ext_id(system: &str, unique_id: &str, url: Option<&str>) -> ExternalIdentifier {
        ExternalIdentifier {
            system: system.to_string(),
            unique_id: unique_id.to_string(),
            url: url.map(|u| u.to_string()),
        }
    }

    #[test]
    fn accepts_http_and_https_schemes() {
        assert!(HttpUrlSpec.is_satisfied_by("http://example.com"));
        assert!(HttpUrlSpec.is_satisfied_by("https://www.imdb.com/title/tt1/"));
        assert!(HttpUrlSpec.is_satisfied_by("  HTTPS://Example.com  "));
    }

    #[test]
    fn rejects_dangerous_and_unknown_schemes() {
        assert!(!HttpUrlSpec.is_satisfied_by("javascript:alert(1)"));
        assert!(!HttpUrlSpec.is_satisfied_by("data:text/html,<script>1</script>"));
        assert!(!HttpUrlSpec.is_satisfied_by("file:///etc/passwd"));
        assert!(!HttpUrlSpec.is_satisfied_by("ftp://example.com"));
        assert!(!HttpUrlSpec.is_satisfied_by(""));
        assert!(!HttpUrlSpec.is_satisfied_by("   "));
    }

    #[test]
    fn validate_accepts_valid_ids() {
        let ids = vec![
            ext_id("IMDB", "tt1", Some("https://www.imdb.com/title/tt1/")),
            ext_id("TMDB", "603", None),
        ];
        assert!(validate_external_ids(&ids).is_ok());
    }

    #[test]
    fn validate_rejects_empty_part() {
        assert!(matches!(
            validate_external_ids(&[ext_id("", "tt1", None)]),
            Err(DomainError::ValidationError(_))
        ));
        assert!(matches!(
            validate_external_ids(&[ext_id("IMDB", "  ", None)]),
            Err(DomainError::ValidationError(_))
        ));
    }

    #[test]
    fn validate_rejects_non_http_url() {
        assert!(matches!(
            validate_external_ids(&[ext_id("IMDB", "tt1", Some("javascript:alert(1)"))]),
            Err(DomainError::ValidationError(_))
        ));
    }

    #[test]
    fn validate_rejects_duplicates() {
        let ids = vec![ext_id("IMDB", "tt1", None), ext_id("IMDB", "tt1", None)];
        assert!(matches!(
            validate_external_ids(&ids),
            Err(DomainError::ValidationError(_))
        ));
    }
}
