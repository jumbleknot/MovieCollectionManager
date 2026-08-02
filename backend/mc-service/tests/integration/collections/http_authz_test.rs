//! Authenticated HTTP authorization tests (feature 046).
//!
//! Every authorization assertion in this suite before this feature was
//! *unauthenticated*: it proved `401` without a token and nothing else. These tests
//! drive the real router with a **real bearer token** minted from Keycloak, so they
//! exercise the authorization behaviour that only exists once a caller is identified.
//!
//! The security-critical assertion here is **cross-tenant `404`** — a foreign-owned
//! resource must be indistinguishable from one that does not exist. Everything else
//! exists to make that assertion interpretable or well-formed.
//!
//! Run:
//!   pnpm nx test:integration mc-service -- collections::http_authz_test

use axum::{
    body::Body,
    http::{Request, Response, StatusCode},
};
use bson::{doc, oid::ObjectId};
use http_body_util::BodyExt;
use mongodb::Database;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use crate::common::auth::{read_credential, subject_from_access_token, user_subject, user_token};

// ─── Local helpers ───────────────────────────────────────────────────────────

/// A request carrying the real bearer credential.
async fn authed(method: &str, uri: &str, body: Option<Value>) -> Request<Body> {
    let builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("Authorization", format!("Bearer {}", user_token().await));

    match body {
        Some(json) => builder
            .header("Content-Type", "application/json")
            .body(Body::from(json.to_string())),
        None => builder.body(Body::empty()),
    }
    .expect("request build failed")
}

/// Drain a response body to a string. Kept as a string (not a parsed value) because
/// the leakage assertion must inspect the WHOLE body, including fields the DTO does
/// not declare.
async fn body_string(response: Response<Body>) -> String {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body read failed")
        .to_bytes();
    String::from_utf8(bytes.to_vec()).expect("body was not UTF-8")
}

/// A collection name no other test can collide with, so a duplicate-name `409` can
/// never be mistaken for an authorization result.
fn unique_name(prefix: &str) -> String {
    format!("{prefix} {}", Uuid::new_v4())
}

/// Read a stored collection document straight from MongoDB.
///
/// The storage-layer assertions go through here rather than through the response:
/// FR-003 is about the **recorded** owner, so a serialization bug that echoes the
/// caller's subject back while persisting something else would pass a response-only
/// check.
async fn stored_collection(db: &Database, id: &str) -> Option<bson::Document> {
    db.collection::<bson::Document>("movie_collections")
        .find_one(
            doc! { "_id": ObjectId::parse_str(id).expect("collection id was not an ObjectId") },
        )
        .await
        .expect("query failed")
}

// ─── Credential-helper failure modes (FR-007, SC-005) ────────────────────────
//
// These two assert the *fail-hard* contract itself: when the harness cannot obtain a
// credential it must say which one, rather than skipping. They are pure-function tests
// precisely so the message can be asserted without mutating process env mid-suite,
// which would race every other test in this binary.

/// A missing credential must be reported by **name**, so a misconfigured run says
/// which variable to set.
#[tokio::test]
async fn missing_credential_failure_names_the_variable() {
    // A key guaranteed absent — following the precedent in src/config.rs's own unit
    // test. Naming a REAL credential (e.g. E2E_TEST_PASSWORD) would break this test
    // silently: T002 puts it in .env.local, any earlier test's dotenvy call loads it
    // into the process env, read_credential would return Ok, and this test would
    // assert nothing at all.
    const ABSENT: &str = "MC_SERVICE_TEST_NONEXISTENT_CREDENTIAL";

    let result = read_credential(ABSENT);

    let message = result.expect_err("an absent credential must not read as Ok");
    assert!(
        message.contains(ABSENT),
        "the failure message must name the variable that is missing, so a \
         misconfigured run is self-diagnosing: expected it to contain {ABSENT:?}, \
         got {message:?}"
    );
}

/// An undecodable token must name which part of the decode failed, rather than
/// failing anonymously.
#[tokio::test]
async fn undecodable_token_failure_names_the_field() {
    let result = subject_from_access_token("not-a-jwt");

    let message = result.expect_err("a malformed token must not decode as Ok");
    assert!(
        message.contains("payload"),
        "the failure message must name what could not be read (the payload segment), \
         got {message:?}"
    );
}

// ─── US2: a signed-in user can reach their own data ──────────────────────────
//
// This story is the CONTROL, and it runs before the cross-tenant story on purpose:
// without it a 404 from US1 is ambiguous, because it could equally mean the credential
// was rejected and everything returns an error.

/// US2-AC3 — given a valid credential, a protected endpoint responds. Never `401`,
/// and never `403`.
#[tokio::test]
async fn authenticated_request_is_never_unauthorized() {
    let app = crate::common::build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/collections")
                .header("Authorization", format!("Bearer {}", user_token().await))
                .body(Body::empty())
                .expect("request build failed"),
        )
        .await
        .expect("router call failed");

    let status = response.status();

    // Both halves matter, and they fail for different reasons:
    //   401 → the signature/audience was not accepted (the token is not valid here);
    //   403 → require_app_role did not see the mc-user role on the token.
    // Asserting only the first would let a role-mapper regression pass.
    assert_ne!(
        status,
        StatusCode::UNAUTHORIZED,
        "a valid credential must never be rejected: got {status}"
    );
    assert_ne!(
        status,
        StatusCode::FORBIDDEN,
        "the test identity must carry the mc-user role: got {status}"
    );
}

/// US2-AC1 (FR-003) — creating a collection succeeds and the **stored** owner is the
/// authenticated subject.
#[tokio::test]
async fn authenticated_create_collection_stamps_authenticated_subject_as_owner() {
    let (app, db) = crate::common::build_test_app_with_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");

    // The expected value comes from the TOKEN, never from the service's own response —
    // comparing a response to itself would pass even if the service stamped a constant.
    let expected_owner = user_subject().await;

    let response = app
        .oneshot(
            authed(
                "POST",
                "/api/v1/collections",
                Some(json!({ "name": unique_name("Owner Stamp"), "description": null })),
            )
            .await,
        )
        .await
        .expect("router call failed");

    let status = response.status();
    let body = body_string(response).await;
    let parsed: Value = serde_json::from_str(&body).expect("response was not JSON");

    let collection_id = parsed
        .get("collectionId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let response_owner = parsed
        .get("ownerId")
        .and_then(Value::as_str)
        .map(str::to_string);

    // Capture the persisted row while the database is still alive.
    let stored_owner = match &collection_id {
        Some(id) => stored_collection(&db, id)
            .await
            .map(|d| d.get_str("ownerId").expect("ownerId missing").to_string()),
        None => None,
    };

    crate::common::cleanup_db(&db).await;

    assert_eq!(
        status,
        StatusCode::CREATED,
        "authenticated create must succeed"
    );
    // Both layers are asserted, and they catch different faults.
    assert_eq!(
        response_owner.as_deref(),
        Some(expected_owner.as_str()),
        "the response's ownerId must be the authenticated subject"
    );
    assert_eq!(
        stored_owner.as_deref(),
        Some(expected_owner.as_str()),
        "the stored ownerId must equal the authenticated subject"
    );
}

/// US2-AC2 — a collection the user owns is returned when requested.
#[tokio::test]
async fn authenticated_owner_can_read_own_collection() {
    let (app, db) = crate::common::build_test_app_with_db().await;
    mc_service::adapters::mongodb::indexes::create_indexes(&db)
        .await
        .expect("index creation failed");

    let created = app
        .clone()
        .oneshot(
            authed(
                "POST",
                "/api/v1/collections",
                Some(json!({ "name": unique_name("Read Back"), "description": null })),
            )
            .await,
        )
        .await
        .expect("router call failed");

    let create_status = created.status();
    let created_body: Value =
        serde_json::from_str(&body_string(created).await).expect("response was not JSON");
    let collection_id = created_body
        .get("collectionId")
        .and_then(Value::as_str)
        .expect("create response carried no collectionId")
        .to_string();

    let read = app
        .oneshot(authed("GET", &format!("/api/v1/collections/{collection_id}"), None).await)
        .await
        .expect("router call failed");

    let read_status = read.status();
    let read_body: Value =
        serde_json::from_str(&body_string(read).await).expect("response was not JSON");
    let read_id = read_body
        .get("collectionId")
        .and_then(Value::as_str)
        .map(str::to_string);

    crate::common::cleanup_db(&db).await;

    assert_eq!(
        create_status,
        StatusCode::CREATED,
        "setup create must succeed"
    );
    assert_eq!(
        read_status,
        StatusCode::OK,
        "the owner must be able to read their own collection"
    );
    assert_eq!(
        read_id.as_deref(),
        Some(collection_id.as_str()),
        "the collection read back must be the one created"
    );
}

// ─── US1: a tenant cannot discover another tenant's data 🎯 ──────────────────
//
// THE security-critical story. A regression here leaks the existence of other
// tenants' data.
//
// A foreign-owned collection cannot be created over HTTP — every write path stamps
// `owner_id = token.subject` (which US2 just proved). It must therefore be seeded
// through the repository, into THE database the router is wired to, which is what
// build_test_app_with_db() exists for.

/// The owner of the foreign fixture. Must never equal the authenticated subject —
/// [`seed_foreign_collection`] asserts exactly that.
const OTHER_TENANT_SUBJECT: &str = "046-other-tenant-6f1c2a90-not-the-test-user";

struct ForeignFixture {
    collection_id: String,
}

/// Seed a collection owned by a **different** subject, directly through the repository.
async fn seed_foreign_collection(db: &Database) -> ForeignFixture {
    use mc_service::adapters::mongodb::collection_repository::MongoCollectionRepository;
    use mc_service::application::dtos::collection_dto::CreateCollectionDto;
    use mc_service::application::ports::collection_repository::CollectionRepository;

    mc_service::adapters::mongodb::indexes::create_indexes(db)
        .await
        .expect("index creation failed");

    // Fixture invariant 1 — checked BEFORE anything is written, so a failure here
    // leaks no database. If the fixture's owner were the caller, every assertion
    // below would be reading the user's own data and would prove nothing.
    assert_ne!(
        OTHER_TENANT_SUBJECT,
        user_subject().await,
        "the foreign fixture's owner must differ from the authenticated subject"
    );

    let repo = MongoCollectionRepository::new(db);
    let created = repo
        .create(
            OTHER_TENANT_SUBJECT,
            CreateCollectionDto {
                name: unique_name("Foreign Tenant"),
                description: None,
            },
        )
        .await
        .expect("foreign fixture create failed");

    ForeignFixture {
        collection_id: created.id,
    }
}

/// US1-AC1 (FR-004) — reading another subject's collection is `404`, never `403`.
#[tokio::test]
async fn foreign_collection_read_is_not_found_not_forbidden() {
    let (app, db) = crate::common::build_test_app_with_db().await;
    let fixture = seed_foreign_collection(&db).await;

    let response = app
        .oneshot(
            authed(
                "GET",
                &format!("/api/v1/collections/{}", fixture.collection_id),
                None,
            )
            .await,
        )
        .await
        .expect("router call failed");

    let status = response.status();
    let still_present = stored_collection(&db, &fixture.collection_id)
        .await
        .is_some();
    crate::common::cleanup_db(&db).await;

    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "cross-tenant read must be 404 (no existence leak): got {status}"
    );
    // Logically redundant with the assert_eq! above — kept deliberately. FR-004
    // explicitly requires failing a 403, and this is the assertion that produces the
    // diagnostic saying WHY: a 403 confirms the resource exists, which is the
    // existence leak this design prevents. Not dead weight for a reviewer to strip.
    assert_ne!(
        status,
        StatusCode::FORBIDDEN,
        "a 403 would confirm the collection exists — the existence leak 404 prevents"
    );
    // Fixture invariant 2 — the 404 must mean "refused", not "absent".
    assert!(
        still_present,
        "the foreign fixture must still exist when the 404 is observed, otherwise \
         the 404 only means the row was never there"
    );
}

/// US1-AC2 (FR-004) — modifying another subject's collection is `404`, and changes
/// nothing.
#[tokio::test]
async fn foreign_collection_update_is_not_found_not_forbidden() {
    let (app, db) = crate::common::build_test_app_with_db().await;
    let fixture = seed_foreign_collection(&db).await;

    let before = stored_collection(&db, &fixture.collection_id)
        .await
        .expect("fixture must exist before the refused update");
    let name_before = before.get_str("name").expect("name missing").to_string();

    let response = app
        .oneshot(
            authed(
                "PATCH",
                &format!("/api/v1/collections/{}", fixture.collection_id),
                Some(json!({ "name": "Renamed By An Intruder" })),
            )
            .await,
        )
        .await
        .expect("router call failed");

    let status = response.status();
    let after = stored_collection(&db, &fixture.collection_id).await;
    let name_after = after
        .as_ref()
        .map(|d| d.get_str("name").expect("name missing").to_string());
    crate::common::cleanup_db(&db).await;

    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "cross-tenant update must be 404 (no existence leak): got {status}"
    );
    assert_ne!(
        status,
        StatusCode::FORBIDDEN,
        "a 403 would confirm the collection exists — the existence leak 404 prevents"
    );
    assert_eq!(
        name_after.as_deref(),
        Some(name_before.as_str()),
        "the foreign collection must be unmodified after a refused update"
    );
}

/// US1-AC2 (FR-004) — deleting another subject's collection is `404`, and deletes
/// nothing.
#[tokio::test]
async fn foreign_collection_delete_is_not_found_not_forbidden() {
    let (app, db) = crate::common::build_test_app_with_db().await;
    let fixture = seed_foreign_collection(&db).await;

    let response = app
        .oneshot(
            authed(
                "DELETE",
                &format!("/api/v1/collections/{}", fixture.collection_id),
                None,
            )
            .await,
        )
        .await
        .expect("router call failed");

    let status = response.status();
    let still_present = stored_collection(&db, &fixture.collection_id)
        .await
        .is_some();
    crate::common::cleanup_db(&db).await;

    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "cross-tenant delete must be 404 (no existence leak): got {status}"
    );
    assert_ne!(
        status,
        StatusCode::FORBIDDEN,
        "a 403 would confirm the collection exists — the existence leak 404 prevents"
    );
    assert!(
        still_present,
        "the foreign collection must survive a refused delete"
    );
}

/// US1-AC3 (FR-005) — a movie inside another subject's collection is `404`.
///
/// This needs its own test and its own mutation: the refusal comes from
/// `authorize_collection_access`, a different seam from the collection repository's
/// owner filter that the three tests above exercise.
#[tokio::test]
async fn foreign_collection_movie_read_is_not_found() {
    use mc_service::adapters::mongodb::movie_repository::MongoMovieRepository;
    use mc_service::application::dtos::movie_dto::CreateMovieDto;
    use mc_service::application::ports::movie_repository::MovieRepository;
    use mc_service::domain::movie::ContentType;

    let (app, db) = crate::common::build_test_app_with_db().await;
    let fixture = seed_foreign_collection(&db).await;

    let movie = MongoMovieRepository::new(&db)
        .create(
            &fixture.collection_id,
            OTHER_TENANT_SUBJECT,
            CreateMovieDto {
                title: unique_name("Foreign Movie"),
                year: 2010,
                content_type: ContentType::Movie,
                language: Some("English".to_string()),
                owned: false,
                ripped: false,
                childrens: false,
                owned_media: vec![],
                rip_quality: vec![],
                genres: vec![],
                rated: None,
                directors: vec![],
                actors: vec![],
                tags: vec![],
                movie_set: None,
                original_title: None,
                release_date: None,
                outline: None,
                plot: None,
                runtime: None,
                external_ids: vec![],
            },
        )
        .await
        .expect("foreign movie fixture create failed");

    let response = app
        .oneshot(
            authed(
                "GET",
                &format!(
                    "/api/v1/collections/{}/movies/{}",
                    fixture.collection_id, movie.id
                ),
                None,
            )
            .await,
        )
        .await
        .expect("router call failed");

    let status = response.status();
    let still_present = stored_collection(&db, &fixture.collection_id)
        .await
        .is_some();
    crate::common::cleanup_db(&db).await;

    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "cross-tenant movie read must be 404: got {status}"
    );
    assert_ne!(
        status,
        StatusCode::FORBIDDEN,
        "a 403 would confirm the collection exists — the existence leak 404 prevents"
    );
    assert!(
        still_present,
        "the foreign fixture must still exist when the 404 is observed"
    );
}

// ─── US3: authorization failures are machine-readable ────────────────────────
//
// These are the first *authenticated* error paths the suite has ever exercised.

/// US3-AC1 (FR-006) — a cross-tenant refusal is a well-formed RFC 9457 problem
/// document.
#[tokio::test]
async fn cross_tenant_refusal_body_is_problem_json() {
    let (app, db) = crate::common::build_test_app_with_db().await;
    let fixture = seed_foreign_collection(&db).await;

    let response = app
        .oneshot(
            authed(
                "GET",
                &format!("/api/v1/collections/{}", fixture.collection_id),
                None,
            )
            .await,
        )
        .await
        .expect("router call failed");

    let status = response.status();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = body_string(response).await;
    crate::common::cleanup_db(&db).await;

    let parsed: Value = serde_json::from_str(&body).expect("refusal body was not JSON");

    assert_eq!(status, StatusCode::NOT_FOUND, "setup: expected a refusal");
    assert!(
        content_type
            .as_deref()
            .is_some_and(|c| c.starts_with("application/problem+json")),
        "error responses must use application/problem+json: got {content_type:?}"
    );

    for field in ["type", "title", "status"] {
        assert!(
            parsed.get(field).is_some(),
            "an RFC 9457 body must carry `{field}`"
        );
    }
    assert_eq!(
        parsed.get("status").and_then(Value::as_u64),
        Some(u64::from(status.as_u16())),
        "the body's `status` must agree with the HTTP status line"
    );

    // Match the SUFFIX, not the whole URI. The `.example` host is a deliberate,
    // non-resolvable RFC 2606 namespace — an assertion must not "correct" it to a
    // real domain.
    let problem_type = parsed
        .get("type")
        .and_then(Value::as_str)
        .expect("`type` must be a string");
    assert!(
        problem_type.ends_with("COLLECTION_NOT_FOUND"),
        "the problem type must identify the error: got {problem_type:?}"
    );
}

/// US3-AC2 (FR-006) — an authenticated error body carries no stack trace or internal
/// diagnostic text.
#[tokio::test]
async fn authenticated_error_body_carries_no_diagnostics() {
    let (app, db) = crate::common::build_test_app_with_db().await;
    let fixture = seed_foreign_collection(&db).await;

    let response = app
        .oneshot(
            authed(
                "GET",
                &format!("/api/v1/collections/{}", fixture.collection_id),
                None,
            )
            .await,
        )
        .await
        .expect("router call failed");

    let status = response.status();
    let body = body_string(response).await;
    crate::common::cleanup_db(&db).await;

    assert_eq!(status, StatusCode::NOT_FOUND, "setup: expected a refusal");

    // Asserted against the WHOLE body string, not against parsed fields: a leak can
    // arrive in any field, including one the DTO does not declare.
    for leak in [
        "panicked",
        "backtrace",
        "src/",
        ".rs:",
        "MongoDB",
        "mongodb::",
        "WriteError",
        "Kind::",
    ] {
        assert!(
            !body.contains(leak),
            "the error body must not leak internal diagnostics: found {leak:?} in the \
             response body"
        );
    }
}
