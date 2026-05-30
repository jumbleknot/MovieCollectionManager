use super::spec::Specification;

/// Enforces that a collection name does not exceed 50 characters and is not empty.
pub struct CollectionNameLengthSpec;

impl Specification<str> for CollectionNameLengthSpec {
    fn is_satisfied_by(&self, name: &str) -> bool {
        !name.is_empty() && name.len() <= 50
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // T023

    #[test]
    fn accepts_name_within_limit() {
        let spec = CollectionNameLengthSpec;
        assert!(spec.is_satisfied_by("My Collection"));
        assert!(spec.is_satisfied_by("A"));
        // exactly 50 chars
        let fifty = "a".repeat(50);
        assert!(spec.is_satisfied_by(&fifty));
    }

    #[test]
    fn rejects_name_exceeding_50_chars() {
        let spec = CollectionNameLengthSpec;
        let fifty_one = "a".repeat(51);
        assert!(!spec.is_satisfied_by(&fifty_one));
    }

    #[test]
    fn rejects_empty_name() {
        let spec = CollectionNameLengthSpec;
        assert!(!spec.is_satisfied_by(""));
    }
}
