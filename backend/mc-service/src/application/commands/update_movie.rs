use std::sync::Arc;

use crate::application::access_control::authorize_collection_access;
use crate::application::dtos::movie_dto::{MovieDto, UpdateMovieDto};
use crate::application::ports::collection_repository::CollectionRepository;
use crate::application::ports::movie_repository::MovieRepository;
use crate::domain::collection::AclRole;
use crate::domain::errors::DomainError;
use crate::domain::movie::Movie;
use crate::domain::specifications::http_url::validate_external_ids;
use crate::domain::specifications::owned_media::OwnedMediaWhenOwnedSpec;
use crate::domain::specifications::required_string::RequiredStringSpec;
use crate::domain::specifications::rip_quality::RipQualityWhenRippedSpec;
use crate::domain::specifications::spec::Specification;

pub struct UpdateMovieCommand {
    pub collection_id: String,
    pub movie_id: String,
    pub owner_id: String,
    pub dto: UpdateMovieDto,
}

pub struct UpdateMovieHandler {
    pub repository: Arc<dyn MovieRepository>,
    pub collection_repository: Arc<dyn CollectionRepository>,
}

impl UpdateMovieHandler {
    pub fn new(
        repository: Arc<dyn MovieRepository>,
        collection_repository: Arc<dyn CollectionRepository>,
    ) -> Self {
        Self {
            repository,
            collection_repository,
        }
    }

    pub async fn handle(&self, cmd: UpdateMovieCommand) -> Result<MovieDto, DomainError> {
        // DAC: caller must be a contributor on the collection (011 FR-001/002/008).
        let collection = authorize_collection_access(
            self.collection_repository.as_ref(),
            &cmd.collection_id,
            &cmd.owner_id,
            AclRole::Contributor,
        )
        .await?;

        // Title must not be empty (FR-022). Language is optional (014 US1).
        if !RequiredStringSpec.is_satisfied_by(&cmd.dto.title) {
            return Err(DomainError::ValidationError(
                "Movie title is required".to_string(),
            ));
        }

        // Validate cross-field invariants
        let mut movie = Movie::new(
            &cmd.dto.title,
            cmd.dto.year,
            cmd.dto.content_type.clone(),
            cmd.dto.language.clone(),
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

        // External-identifier scheme / non-empty / duplicate validation (FR-001/002).
        validate_external_ids(&cmd.dto.external_ids)?;

        // Stamp ownerId as the COLLECTION owner, never the acting user (011 FR-005).
        self.repository
            .update(
                &cmd.collection_id,
                &cmd.movie_id,
                &collection.owner_id,
                cmd.dto,
            )
            .await
    }
}

// ─── Unit tests (T158) ───────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application::dtos::movie_dto::{
        CreateMovieDto, FilterOptionsDto, MovieDto, MovieListDto, UpdateMovieDto,
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

            async fn count(
                &self,
                collection_id: &str,
                owner_id: &str,
                params: ListMoviesParams,
            ) -> Result<u64, DomainError>;

            async fn get_filter_options(
                &self,
                collection_id: &str,
                owner_id: &str,
            ) -> Result<FilterOptionsDto, DomainError>;
        }
    }

    fn make_dto(owned: bool, ripped: bool) -> UpdateMovieDto {
        UpdateMovieDto {
            title: "The Matrix".to_string(),
            year: 1999,
            content_type: ContentType::Movie,
            language: Some("en".to_string()),
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

    use crate::application::dtos::collection_dto::{
        CollectionDto, CollectionSummaryDto, CreateCollectionDto,
    };
    use crate::application::ports::collection_repository::CollectionRepository;
    use crate::domain::collection::MovieCollection;

    mock! {
        CollRepo {}
        #[async_trait::async_trait]
        impl CollectionRepository for CollRepo {
            async fn create(&self, owner_id: &str, dto: CreateCollectionDto) -> Result<CollectionDto, DomainError>;
            async fn get_by_id(&self, id: &str, owner_id: &str) -> Result<CollectionDto, DomainError>;
            async fn find_by_id(&self, id: &str) -> Result<MovieCollection, DomainError>;
            async fn list_by_owner(&self, owner_id: &str) -> Result<Vec<CollectionSummaryDto>, DomainError>;
            async fn update(&self, id: &str, owner_id: &str, dto: crate::application::dtos::collection_dto::UpdateCollectionDto) -> Result<CollectionDto, DomainError>;
            async fn delete(&self, id: &str, owner_id: &str) -> Result<(), DomainError>;
            async fn find_default_for_owner(&self, owner_id: &str) -> Result<Option<CollectionDto>, DomainError>;
            async fn clear_default_for_owner(&self, owner_id: &str) -> Result<(), DomainError>;
            async fn set_as_default(&self, id: &str, owner_id: &str) -> Result<CollectionDto, DomainError>;
        }
    }

    /// Handler whose collection mock authorizes caller `owner-789` as owner.
    fn make_handler(repo: MockMovieRepo) -> UpdateMovieHandler {
        let mut coll = MockCollRepo::new();
        coll.expect_find_by_id()
            .returning(|_| Ok(MovieCollection::new("owner-789", "C", None)));
        UpdateMovieHandler::new(Arc::new(repo), Arc::new(coll))
    }

    fn make_cmd(dto: UpdateMovieDto) -> UpdateMovieCommand {
        UpdateMovieCommand {
            collection_id: "coll-123".to_string(),
            movie_id: "movie-456".to_string(),
            owner_id: "owner-789".to_string(),
            dto,
        }
    }

    fn make_result_dto() -> MovieDto {
        MovieDto {
            id: "movie-456".to_string(),
            collection_id: "coll-123".to_string(),
            title: "The Matrix".to_string(),
            year: 1999,
            content_type: ContentType::Movie,
            language: Some("en".to_string()),
            owned: true,
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
    async fn update_movie_success_returns_dto() {
        let mut repo = MockMovieRepo::new();
        repo.expect_update()
            .withf(|cid, mid, oid, _| cid == "coll-123" && mid == "movie-456" && oid == "owner-789")
            .times(1)
            .returning(|_, _, _, _| Ok(make_result_dto()));

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(make_dto(true, false))).await;
        assert!(result.is_ok(), "update should return Ok on success");
        let dto = result.unwrap();
        assert_eq!(dto.id, "movie-456");
    }

    #[tokio::test]
    async fn update_movie_rejects_owned_media_when_not_owned() {
        let mut repo = MockMovieRepo::new();
        repo.expect_update().times(0); // must never reach repository

        let mut dto = make_dto(false, false); // not owned
        dto.owned_media = vec![MediaFormat::BluRay]; // but has owned_media → invalid

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(
            matches!(result, Err(DomainError::OwnedMediaWhenNotOwned)),
            "OwnedMediaWhenNotOwned spec must be enforced before repository call"
        );
    }

    #[tokio::test]
    async fn update_movie_rejects_rip_quality_when_not_ripped() {
        let mut repo = MockMovieRepo::new();
        repo.expect_update().times(0); // must never reach repository

        let mut dto = make_dto(true, false); // not ripped
        dto.rip_quality = vec![MediaFormat::BluRay]; // but has rip_quality → invalid

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(
            matches!(result, Err(DomainError::RipQualityWhenNotRipped)),
            "RipQualityWhenNotRipped spec must be enforced before repository call"
        );
    }

    #[tokio::test]
    async fn update_movie_propagates_movie_not_found() {
        let mut repo = MockMovieRepo::new();
        repo.expect_update()
            .times(1)
            .returning(|_, _, _, _| Err(DomainError::MovieNotFound));

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(make_dto(false, false))).await;
        assert!(
            matches!(result, Err(DomainError::MovieNotFound)),
            "MovieNotFound must propagate from repository"
        );
    }

    #[tokio::test]
    async fn update_movie_propagates_collection_not_found() {
        let mut repo = MockMovieRepo::new();
        repo.expect_update()
            .times(1)
            .returning(|_, _, _, _| Err(DomainError::CollectionNotFound));

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(make_dto(false, false))).await;
        assert!(
            matches!(result, Err(DomainError::CollectionNotFound)),
            "CollectionNotFound must propagate from repository"
        );
    }

    #[tokio::test]
    async fn update_movie_allows_owned_media_when_owned() {
        let mut repo = MockMovieRepo::new();
        repo.expect_update()
            .times(1)
            .returning(|_, _, _, _| Ok(make_result_dto()));

        let mut dto = make_dto(true, false); // owned = true
        dto.owned_media = vec![MediaFormat::BluRay]; // owned_media is valid

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(result.is_ok(), "owned_media is valid when owned=true");
    }

    #[tokio::test]
    async fn update_movie_allows_rip_quality_when_ripped() {
        let mut repo = MockMovieRepo::new();
        repo.expect_update()
            .times(1)
            .returning(|_, _, _, _| Ok(make_result_dto()));

        let mut dto = make_dto(true, true); // owned=true, ripped=true
        dto.rip_quality = vec![MediaFormat::BluRay]; // rip_quality is valid

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(result.is_ok(), "rip_quality is valid when ripped=true");
    }

    // ─── External-id validation (009 finding #1, FR-001/002) ──────────────────

    use crate::domain::external_id::ExternalIdentifier;

    fn ext_id(system: &str, unique_id: &str, url: Option<&str>) -> ExternalIdentifier {
        ExternalIdentifier {
            system: system.to_string(),
            unique_id: unique_id.to_string(),
            url: url.map(|u| u.to_string()),
        }
    }

    #[tokio::test]
    async fn update_movie_rejects_non_http_external_id_url() {
        let mut repo = MockMovieRepo::new();
        repo.expect_update().times(0); // must never reach repository

        let mut dto = make_dto(true, false);
        dto.external_ids = vec![ext_id(
            "IMDB",
            "tt1",
            Some("data:text/html,<script>1</script>"),
        )];

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(
            matches!(result, Err(DomainError::ValidationError(_))),
            "non-http(s) external-id url must be rejected on update"
        );
    }

    #[tokio::test]
    async fn update_movie_allows_valid_https_external_id() {
        let mut repo = MockMovieRepo::new();
        repo.expect_update()
            .times(1)
            .returning(|_, _, _, _| Ok(make_result_dto()));

        let mut dto = make_dto(true, false);
        dto.external_ids = vec![ext_id(
            "TMDB",
            "603",
            Some("https://themoviedb.org/movie/603"),
        )];

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(
            result.is_ok(),
            "a valid https external-id url must be accepted on update"
        );
    }

    // ─── Required-field validation (009 FR-022) ───────────────────────────────

    #[tokio::test]
    async fn update_movie_required_fields_rejects_empty_title() {
        let mut repo = MockMovieRepo::new();
        repo.expect_update().times(0);

        let mut dto = make_dto(true, false);
        dto.title = "  ".to_string();

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(matches!(result, Err(DomainError::ValidationError(_))));
    }

    // ─── Optional language (014 US1, US1-AC1/AC2) ─────────────────────────────

    #[tokio::test]
    async fn update_movie_accepts_absent_language() {
        let mut repo = MockMovieRepo::new();
        repo.expect_update()
            .times(1)
            .returning(|_, _, _, _| Ok(make_result_dto()));

        let mut dto = make_dto(true, false);
        dto.language = None;

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(
            result.is_ok(),
            "a full-replace update that clears language must be accepted (014 US1)"
        );
    }
}
