use super::spec::Specification;

/// A required string field must contain at least one non-whitespace character.
///
/// Used to enforce that documented-required movie fields (e.g. title, language)
/// cannot be persisted empty (009 FR-022).
pub struct RequiredStringSpec;

impl Specification<str> for RequiredStringSpec {
    fn is_satisfied_by(&self, candidate: &str) -> bool {
        !candidate.trim().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_non_empty() {
        assert!(RequiredStringSpec.is_satisfied_by("Inception"));
        assert!(RequiredStringSpec.is_satisfied_by("English"));
    }

    #[test]
    fn rejects_empty_or_whitespace() {
        assert!(!RequiredStringSpec.is_satisfied_by(""));
        assert!(!RequiredStringSpec.is_satisfied_by("   "));
        assert!(!RequiredStringSpec.is_satisfied_by("\t\n"));
    }
}
