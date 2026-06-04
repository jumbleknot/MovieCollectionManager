use std::sync::Arc;

use crate::application::access_control::authorize_collection_access;
use crate::application::dtos::movie_dto::{CreateMovieDto, MovieDto};
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

pub struct CreateMovieCommand {
    pub collection_id: String,
    pub owner_id: String,
    pub dto: CreateMovieDto,
}

pub struct CreateMovieHandler {
    pub repository: Arc<dyn MovieRepository>,
    pub collection_repository: Arc<dyn CollectionRepository>,
}

impl CreateMovieHandler {
    pub fn new(
        repository: Arc<dyn MovieRepository>,
        collection_repository: Arc<dyn CollectionRepository>,
    ) -> Self {
        Self {
            repository,
            collection_repository,
        }
    }

    pub async fn handle(&self, cmd: CreateMovieCommand) -> Result<MovieDto, DomainError> {
        // DAC: caller must be a contributor on the target collection (deny-by-default;
        // missing/unauthorized → CollectionNotFound, no existence leak) (011 FR-001/002/008).
        let collection = authorize_collection_access(
            self.collection_repository.as_ref(),
            &cmd.collection_id,
            &cmd.owner_id,
            AclRole::Contributor,
        )
        .await?;

        // Required fields must not be empty (FR-022).
        if !RequiredStringSpec.is_satisfied_by(&cmd.dto.title)
            || !RequiredStringSpec.is_satisfied_by(&cmd.dto.language)
        {
            return Err(DomainError::ValidationError(
                "Movie title and language are required".to_string(),
            ));
        }

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

        // External-identifier scheme / non-empty / duplicate validation (FR-001/002).
        validate_external_ids(&cmd.dto.external_ids)?;

        // Stamp the movie's owner as the COLLECTION owner, never the acting user
        // (011 FR-005) — keeps ownerId uniform per collection.
        self.repository
            .create(&cmd.collection_id, &collection.owner_id, cmd.dto)
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

    use crate::application::dtos::collection_dto::{
        CollectionDto, CollectionSummaryDto, CreateCollectionDto, UpdateCollectionDto,
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
            async fn update(&self, id: &str, owner_id: &str, dto: UpdateCollectionDto) -> Result<CollectionDto, DomainError>;
            async fn delete(&self, id: &str, owner_id: &str) -> Result<(), DomainError>;
            async fn find_default_for_owner(&self, owner_id: &str) -> Result<Option<CollectionDto>, DomainError>;
            async fn clear_default_for_owner(&self, owner_id: &str) -> Result<(), DomainError>;
            async fn set_as_default(&self, id: &str, owner_id: &str) -> Result<CollectionDto, DomainError>;
        }
    }

    /// Build a handler whose collection mock authorizes the command's caller
    /// (`owner-456`) as the owner — so authorization passes and the collection
    /// owner used for stamping equals `owner-456` (existing assertions hold).
    fn make_handler(repo: MockMovieRepo) -> CreateMovieHandler {
        let mut coll = MockCollRepo::new();
        coll.expect_find_by_id()
            .returning(|_| Ok(MovieCollection::new("owner-456", "C", None)));
        CreateMovieHandler::new(Arc::new(repo), Arc::new(coll))
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

        let handler = make_handler(repo);
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

        let handler = make_handler(repo);
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

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(matches!(result, Err(DomainError::ValidationError(_))));
    }

    #[tokio::test]
    async fn create_movie_rejects_owned_media_when_not_owned() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create().times(0);

        let mut dto = make_dto(false, false); // not owned
        dto.owned_media = vec![MediaFormat::Dvd]; // invalid

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(matches!(result, Err(DomainError::OwnedMediaWhenNotOwned)));
    }

    #[tokio::test]
    async fn create_movie_rejects_rip_quality_when_not_ripped() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create().times(0);

        let mut dto = make_dto(true, false); // not ripped
        dto.rip_quality = vec![MediaFormat::BluRay]; // invalid

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(matches!(result, Err(DomainError::RipQualityWhenNotRipped)));
    }

    #[tokio::test]
    async fn create_movie_propagates_duplicate_error() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create()
            .times(1)
            .returning(|_, _, _| Err(DomainError::DuplicateMovie));

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(make_dto(false, false))).await;
        assert!(matches!(result, Err(DomainError::DuplicateMovie)));
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
    async fn create_movie_rejects_non_http_external_id_url() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create().times(0); // must never reach repository

        let mut dto = make_dto(false, false);
        dto.external_ids = vec![ext_id(
            "IMDB",
            "tt1",
            Some("javascript:alert(document.cookie)"),
        )];

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(
            matches!(result, Err(DomainError::ValidationError(_))),
            "non-http(s) external-id url must be rejected"
        );
    }

    #[tokio::test]
    async fn create_movie_rejects_empty_external_id_part() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create().times(0);

        let mut dto = make_dto(false, false);
        dto.external_ids = vec![ext_id("", "tt1", None)];

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(
            matches!(result, Err(DomainError::ValidationError(_))),
            "empty external-id system/uniqueId must be rejected"
        );
    }

    #[tokio::test]
    async fn create_movie_rejects_duplicate_external_ids() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create().times(0);

        let mut dto = make_dto(false, false);
        dto.external_ids = vec![ext_id("IMDB", "tt1", None), ext_id("IMDB", "tt1", None)];

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(
            matches!(result, Err(DomainError::ValidationError(_))),
            "duplicate (system, uniqueId) external ids must be rejected"
        );
    }

    #[tokio::test]
    async fn create_movie_allows_valid_https_external_id() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create()
            .times(1)
            .returning(|_, _, _| Ok(make_result_dto()));

        let mut dto = make_dto(false, false);
        dto.external_ids = vec![ext_id(
            "IMDB",
            "tt1",
            Some("https://www.imdb.com/title/tt1/"),
        )];

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(
            result.is_ok(),
            "a valid https external-id url must be accepted"
        );
    }

    // ─── Required-field validation (009 FR-022) ───────────────────────────────

    #[tokio::test]
    async fn create_movie_required_fields_rejects_empty_title() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create().times(0);

        let mut dto = make_dto(false, false);
        dto.title = "   ".to_string();

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(matches!(result, Err(DomainError::ValidationError(_))));
    }

    #[tokio::test]
    async fn create_movie_required_fields_rejects_empty_language() {
        let mut repo = MockMovieRepo::new();
        repo.expect_create().times(0);

        let mut dto = make_dto(false, false);
        dto.language = "".to_string();

        let handler = make_handler(repo);
        let result = handler.handle(make_cmd(dto)).await;
        assert!(matches!(result, Err(DomainError::ValidationError(_))));
    }
}
