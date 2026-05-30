use super::spec::Specification;
use crate::domain::movie::Movie;

/// `ripQuality` must be empty when `ripped` is false.
pub struct RipQualityWhenRippedSpec;

impl Specification<Movie> for RipQualityWhenRippedSpec {
    fn is_satisfied_by(&self, movie: &Movie) -> bool {
        if !movie.ripped {
            movie.rip_quality.is_empty()
        } else {
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::movie::{ContentType, Movie};

    fn base_movie() -> Movie {
        Movie::new(
            "Test Movie".to_string(),
            2020,
            ContentType::Movie,
            "English".to_string(),
            false,
            false,
            false,
        )
    }

    #[test]
    fn satisfied_when_ripped_false_and_rip_quality_empty() {
        let movie = base_movie(); // ripped=false, rip_quality=[]
        assert!(RipQualityWhenRippedSpec.is_satisfied_by(&movie));
    }

    #[test]
    fn not_satisfied_when_ripped_false_and_rip_quality_not_empty() {
        use crate::domain::movie::MediaFormat;
        let mut movie = base_movie();
        movie.rip_quality = vec![MediaFormat::BluRay];
        assert!(!RipQualityWhenRippedSpec.is_satisfied_by(&movie));
    }

    #[test]
    fn satisfied_when_ripped_true_regardless_of_rip_quality() {
        use crate::domain::movie::MediaFormat;
        let mut movie = base_movie();
        movie.ripped = true;
        movie.rip_quality = vec![MediaFormat::UhdBluRay];
        assert!(RipQualityWhenRippedSpec.is_satisfied_by(&movie));
    }
}
