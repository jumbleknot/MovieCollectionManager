use super::spec::Specification;
use crate::domain::movie::Movie;

/// `ownedMedia` must be empty when `owned` is false.
pub struct OwnedMediaWhenOwnedSpec;

impl Specification<Movie> for OwnedMediaWhenOwnedSpec {
    fn is_satisfied_by(&self, movie: &Movie) -> bool {
        if !movie.owned {
            movie.owned_media.is_empty()
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
            Some("English".to_string()),
            false,
            false,
            false,
        )
    }

    #[test]
    fn satisfied_when_owned_false_and_owned_media_empty() {
        let movie = base_movie(); // owned=false, owned_media=[]
        assert!(OwnedMediaWhenOwnedSpec.is_satisfied_by(&movie));
    }

    #[test]
    fn not_satisfied_when_owned_false_and_owned_media_not_empty() {
        use crate::domain::movie::MediaFormat;
        let mut movie = base_movie();
        movie.owned_media = vec![MediaFormat::Dvd];
        assert!(!OwnedMediaWhenOwnedSpec.is_satisfied_by(&movie));
    }

    #[test]
    fn satisfied_when_owned_true_regardless_of_owned_media() {
        use crate::domain::movie::MediaFormat;
        let mut movie = base_movie();
        movie.owned = true;
        movie.owned_media = vec![MediaFormat::BluRay];
        assert!(OwnedMediaWhenOwnedSpec.is_satisfied_by(&movie));
    }
}
