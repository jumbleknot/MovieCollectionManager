use std::sync::Arc;

use crate::application::dtos::movie_dto::{CreateMovieDto, MovieDto};
use crate::application::ports::movie_repository::MovieRepository;
use crate::domain::errors::DomainError;
use crate::domain::movie::Movie;
use crate::domain::specifications::owned_media::OwnedMediaWhenOwnedSpec;
use crate::domain::specifications::rip_quality::RipQualityWhenRippedSpec;
use crate::domain::specifications::spec::Specification;

pub struct CreateMovieCommand {
    pub collection_id: String,
    pub owner_id: String,
    pub dto: CreateMovieDto,
}

pub struct CreateMovieHandler {
    pub repository: Arc<dyn MovieRepository>,
}

impl CreateMovieHandler {
    pub fn new(repository: Arc<dyn MovieRepository>) -> Self {
        Self { repository }
    }

    pub async fn handle(&self, cmd: CreateMovieCommand) -> Result<MovieDto, DomainError> {
        // Validate year range
        if cmd.dto.year < 1000 || cmd.dto.year > 9999 {
            return Err(DomainError::ValidationError(
                "Year must be a 4-digit number".to_string(),
            ));
        }

        // Build a domain Movie to run cross-field specs against
        let mut movie = Movie::new(
            &cmd.dto.title,
            cmd.dto.year,
            cmd.dto.content_type.clone(),
            &cmd.dto.language,
            cmd.dto.owned,
            cmd.dto.ripped,
            cmd.dto.childrens,
        );
        movie.owned_media = cmd.dto.owned_media.clone();
        movie.rip_quality = cmd.dto.rip_quality.clone();

        if !OwnedMediaWhenOwnedSpec.is_satisfied_by(&movie) {
            return Err(DomainError::OwnedMediaWhenNotOwned);
        }
        if !RipQualityWhenRippedSpec.is_satisfied_by(&movie) {
            return Err(DomainError::RipQualityWhenNotRipped);
        }

        self.repository
            .create(&cmd.collection_id, &cmd.owner_id, cmd.dto)
            .await
    }
}

// ─── Unit tests (T158) ───────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::dtos::movie_dto::{
        FilterOptionsDto, MovieDto, MovieListDto, UpdateMovieDto,
    };
    use crate::application::ports::movie_repository::ListMoviesParams;
    use crate::domain::movie::{ContentType, MediaFormat};
    use mockall::mock;

    mock! {
        MovieRepo {}
        #[async_trait::async_trait]
        impl MovieRepository for MovieRepo {
            async fn create(
                &self,
                collection_id: &str,
                owner_id: &str,
                dto: CreateMovieDto,
            ) -> Result<MovieDto, DomainError>;

            async fn get_by_id(
                &self,
                collection_id: &str,
                movie_id: &str,
                owner_id: &str,
            ) -> Result<MovieDto, DomainError>;

            async fn update(
                &self,
                collection_id: &str,
                movie_id: &str,
                owner_id: &str,
                dto: UpdateMovieDto,
            ) -> Result<MovieDto, DomainError>;

            async fn delete(
                &self,
                collection_id: &str,
                movie_id: &str,
                owner_id: &str,
            ) -> Result<(), DomainError>;

            async fn list(
                &self,
                collection_id: &str,
                owner_id: &str,
                params: ListMoviesParams,
            ) -> Result<MovieListDto, DomainError>;

            async fn get_filter_options(
                &self,
                collection_id: &str,
                owner_id: &str,
            ) -> Result<FilterOptionsDto, DomainError>;
        }
    }

    fn make_dto(owned: bool, ripped: bool) -> CreateMovieDto {
        CreateMovieDto {
            title: "Inception".to_string(),
            year: 2010,
            content_type: ContentType::Movie,
            language: "en".to_string(),
            owned,
            ripped,
            childrens: false,
            original_title: None,
            release_date: None,
            outline: None,
            plot: None,
            runtime: None,
            rated: None,
            directors: vec![],
            actors: vec![],
            movie_set: None,
            tags: vec![],
            genres: vec![],
            owned_media: vec![],
            rip_quality: vec![],
            external_ids: vec![],
        }
    }

    fn make_cmd(dto: CreateMovieDto) -> CreateMovieCommand {
        CreateMovieCommand {
            collection_id: "coll-123".to_string(),
            owner_id: "owner-456".to_string(),
            dto,
        }
    }

    fn make_result_dto() -> MovieDto {
        MovieDto {
            id: "movie-789".to_string(),
            collection_id: "coll-123".to_string(),
            title: "Inception".to_string(),
            year: 2010,
            content_type: ContentType::Movie,
            language: "en".to_string(),
            owned: false,
            ripped: false,
            childrens: false,
            original_title: None,
            release_date: None,
            outline: None,
            plot: None,
            runtime: None,
            rated: None,
            directors: vec![],
            actors: vec![],
            movie_set: None,
            tags: vec![],
            genres: vec![],
            owned_media: vec![],
            rip_quality: vec![],
            external_ids: vec![],
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn create_movie_success_returns_dto() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create()
            .withf(|cid, oid, _| cid == "coll-123" && oid == "owner-456")
            .times(1)
            .returning(|_, _, _| Ok(make_result_dto()));

        let handler = CreateMovieHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd(make_dto(false, false))).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().title, "Inception");
    }

    #[tokio::test]
    async fn create_movie_rejects_year_below_1000() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create().times(0);

        let mut dto = make_dto(false, false);
        dto.year = 999;

        let handler = CreateMovieHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd(dto)).await;
        assert!(
            matches!(result, Err(DomainError::ValidationError(_))),
            "year < 1000 must be rejected"
        );
    }

    #[tokio::test]
    async fn create_movie_rejects_year_above_9999() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create().times(0);

        let mut dto = make_dto(false, false);
        dto.year = 10000;

        let handler = CreateMovieHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd(dto)).await;
        assert!(matches!(result, Err(DomainError::ValidationError(_))));
    }

    #[tokio::test]
    async fn create_movie_rejects_owned_media_when_not_owned() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create().times(0);

        let mut dto = make_dto(false, false); // not owned
        dto.owned_media = vec![MediaFormat::Dvd]; // invalid

        let handler = CreateMovieHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd(dto)).await;
        assert!(matches!(result, Err(DomainError::OwnedMediaWhenNotOwned)));
    }

    #[tokio::test]
    async fn create_movie_rejects_rip_quality_when_not_ripped() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create().times(0);

        let mut dto = make_dto(true, false); // not ripped
        dto.rip_quality = vec![MediaFormat::BluRay]; // invalid

        let handler = CreateMovieHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd(dto)).await;
        assert!(matches!(result, Err(DomainError::RipQualityWhenNotRipped)));
    }

    #[tokio::test]
    async fn create_movie_propagates_duplicate_error() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create()
            .times(1)
            .returning(|_, _, _| Err(DomainError::DuplicateMovie));

        let handler = CreateMovieHandler::new(Arc::new(repo));
        let result = handler.handle(make_cmd(make_dto(false, false))).await;
        assert!(matches!(result, Err(DomainError::DuplicateMovie)));
    }
}
