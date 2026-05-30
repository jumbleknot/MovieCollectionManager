use super::spec::Specification;
use crate::domain::movie::MediaFormat;

/// Validates that a MediaFormat value is one of: DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray.
pub struct MediaFormatValidSpec;

impl Specification<MediaFormat> for MediaFormatValidSpec {
    fn is_satisfied_by(&self, _candidate: &MediaFormat) -> bool {
        // All enum variants are valid by definition
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_media_format_variants_are_valid() {
        assert!(MediaFormatValidSpec.is_satisfied_by(&MediaFormat::Dvd));
        assert!(MediaFormatValidSpec.is_satisfied_by(&MediaFormat::BluRay));
        assert!(MediaFormatValidSpec.is_satisfied_by(&MediaFormat::BluRay3D));
        assert!(MediaFormatValidSpec.is_satisfied_by(&MediaFormat::UhdBluRay));
    }
}
