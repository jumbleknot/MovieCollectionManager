//! HTTP integration tests for `GET /api/v1/movie-metadata` (feature 047 US4, RQ-4).
//!
//! The conversational assistant must offer exactly the media formats this service accepts, and
//! the constitution's *No Domain Logic in Agents* forbids the agent holding a copy of them. So
//! the domain publishes them here and the agent asks.
//!
//! Two things are asserted that a unit test cannot reach:
//!
//! 1. **The route inherits the protected router's layers.** It carries no per-handler guard —
//!    role enforcement is a layer (see openwiki/gotchas/role-enforcement-is-a-layer.md) — so the
//!    only way to prove `401`/`403` actually apply to it is over HTTP.
//! 2. **The published values are the ones the write endpoints accept.** A member picks from this
//!    list and the value is sent straight back in `ownedMedia`/`ripQuality`; if the two ever
//!    disagree, every ownership add fails validation.
//!
//! Uses the authenticated harness from features 045/046 (`common::auth`), which fails hard
//! rather than skipping — a suite that passes for the wrong reason is worse than one that does
//! not run.
//!
//! Run:
//!   pnpm nx test:integration mc-service -- movies::movie_metadata_test

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use crate::common::auth::user_token;
use crate::common::build_test_app;

const URI: &str = "/api/v1/movie-metadata";

/// The exact set this service accepts today. Spelled out rather than derived from the domain on
/// purpose: deriving both sides from `MediaFormat::all()` would make the test agree with the
/// implementation by construction and assert nothing about the published contract.
const EXPECTED_FORMATS: [&str; 4] = ["DVD", "Blu-Ray", "Blu-Ray 3D", "UHD Blu-Ray"];

async fn body_json(response: axum::http::Response<Body>) -> Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body read failed")
        .to_bytes();
    serde_json::from_slice(&bytes).expect("response body was not JSON")
}

// ─── Authentication and authorization (inherited layers, no per-handler guard) ───

/// Without a JWT the request is rejected by `auth_layer`, exactly like every other
/// `/api/v1` route. This is the assertion that proves the route was nested INSIDE
/// `protected` rather than beside it.
#[tokio::test]
async fn movie_metadata_returns_401_without_jwt() {
    let app = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(URI)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::UNAUTHORIZED,
        "movie-metadata must sit inside the protected router"
    );
}

/// A malformed bearer token is rejected too — proving the layer VALIDATES the credential
/// rather than merely checking that the header is present.
///
/// The expected status is `400`, not `401`. That is `axum-keycloak-auth`'s service-wide
/// behaviour for a token that cannot be parsed as a JWT at all (a well-formed but invalid
/// token yields `401`), and it was verified to be identical on the pre-existing
/// `/api/v1/collections` route before being asserted here. Pinning the real behaviour keeps
/// this a genuine test of the shared layer; asserting `401` because it reads better would
/// have made the route look special when it is not.
#[tokio::test]
async fn movie_metadata_rejects_a_malformed_token() {
    let app = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(URI)
                .header("Authorization", "Bearer not-a-real-jwt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "an unparseable credential must be rejected by the shared auth layer"
    );
    assert_ne!(
        response.status(),
        StatusCode::OK,
        "the endpoint must never serve an anonymous caller"
    );
}

// ─── The published contract ─────────────────────────────────────────────────────

/// The happy path: 200 with the contract's body shape
/// (specs/047-movie-assistant-enhancements/contracts/movie-metadata.md §1).
#[tokio::test]
async fn movie_metadata_returns_the_accepted_media_formats() {
    let app = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(URI)
                .header("Authorization", format!("Bearer {}", user_token().await))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);

    let json = body_json(response).await;
    let formats = json
        .get("mediaFormats")
        .expect("response has no `mediaFormats` key")
        .as_array()
        .expect("`mediaFormats` was not an array");

    let values: Vec<&str> = formats
        .iter()
        .map(|v| v.as_str().expect("not a string"))
        .collect();
    assert_eq!(
        values, EXPECTED_FORMATS,
        "published formats drifted from the accepted set (order is display order)"
    );
}

/// An object, not a bare array — so publishing further enumerations later (content types,
/// ratings) is additive rather than breaking.
#[tokio::test]
async fn movie_metadata_body_is_an_object_not_an_array() {
    let app = build_test_app().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(URI)
                .header("Authorization", format!("Bearer {}", user_token().await))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let json = body_json(response).await;
    assert!(json.is_object(), "expected an object body, got {json}");
}

/// Not collection-scoped and carrying no user data, so it must not require — or leak — one.
/// This is what makes the process-wide TTL cache on the agent side safe.
#[tokio::test]
async fn movie_metadata_carries_no_user_data() {
    let app = build_test_app().await;
    let token = user_token().await;

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(URI)
                .header("Authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let json = body_json(response).await;
    let object = json.as_object().expect("expected an object body");
    assert_eq!(
        object.keys().collect::<Vec<_>>(),
        vec!["mediaFormats"],
        "the response must carry nothing but the published enumerations"
    );
}
