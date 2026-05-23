use super::spec::Specification;
use crate::domain::movie::ContentType;

/// Validates that a ContentType value is one of the allowed enum variants.
/// Since ContentType is a Rust enum, deserialization already enforces this.
/// This spec exists for application-layer composition.
pub struct ContentTypeValidSpec;

impl Specification<ContentType> for ContentTypeValidSpec {
    fn is_satisfied_by(&self, _candidate: &ContentType) -> bool {
        // All enum variants are valid by definition
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_content_type_variants_are_valid() {
        assert!(ContentTypeValidSpec.is_satisfied_by(&ContentType::Movie));
        assert!(ContentTypeValidSpec.is_satisfied_by(&ContentType::Series));
        assert!(ContentTypeValidSpec.is_satisfied_by(&ContentType::Concert));
    }
}
