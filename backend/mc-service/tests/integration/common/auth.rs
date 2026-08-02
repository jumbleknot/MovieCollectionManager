//! Test credential helper — mints a real bearer token for the seeded test identity.
//!
//! Feature 046. Contract: specs/046-authenticated-authz-tests/contracts/test-credential-helper.md
//!
//! Every assertion in the integration suite before this feature was *unauthenticated* —
//! it proved 401 without a token and nothing else. This module supplies the one real
//! credential the authenticated authorization tests need.
//!
//! Two rules govern everything here:
//!
//! 1. **Fail hard, never skip.** A harness that cannot authenticate has nothing
//!    meaningful left to assert, so every failure path panics naming what went wrong.
//!    There is no conditional gate and no `#[ignore]` — a suite that passes for the
//!    wrong reason is worse than one that does not run (feature 045's lesson).
//! 2. **Never log a secret.** Not the access token, not the client secret, not the
//!    password, and not the token endpoint's response body (it can carry credential
//!    material). Messages name *variables* and *endpoints* only.
//!    (Constitution: Sensitive Data Prohibition.)
//!
//! This helper reaches **Keycloak** over HTTP and nothing else. The service under test
//! is always driven in-process via `tower::ServiceExt::oneshot`.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use tokio::sync::OnceCell;

/// The seeded test identity's credential, minted once per test binary.
struct TestIdentity {
    access_token: String,
    subject: String,
}

/// One token per test **binary**. The suite finishes well inside the token lifetime,
/// so there is no refresh path.
static IDENTITY: OnceCell<TestIdentity> = OnceCell::const_new();

/// A cached bearer access token for the seeded test identity.
///
/// **Panics** rather than returning an error: a harness that cannot authenticate has
/// nothing meaningful left to assert, and FR-007 requires a missing credential to fail
/// the run loudly rather than skip it.
pub async fn user_token() -> String {
    identity().await.access_token.clone()
}

/// The `sub` claim of the token returned by [`user_token`] — the identity the service
/// will record as the owner of anything this test creates.
///
/// Assertions must take the expected subject from **here**, never from the service's
/// own response: comparing a response to itself would pass even if the service stamped
/// a constant.
pub async fn user_subject() -> String {
    identity().await.subject.clone()
}

async fn identity() -> &'static TestIdentity {
    IDENTITY.get_or_init(mint_identity).await
}

/// Perform the OAuth2 Resource Owner Password Credentials grant against Keycloak.
///
/// Every failure path panics naming the variable, the endpoint, or the status code.
/// **The response body is never echoed** — it can carry credential material.
async fn mint_identity() -> TestIdentity {
    // The working directory differs between a repo-root and a package-root cargo run,
    // so try both locations; both may legitimately fail if the values are already in
    // the process env (as they are in CI). This mirrors `common::test_db()`.
    let _ = dotenvy::from_filename("backend/mc-service/.env.local");
    let _ = dotenvy::dotenv();

    let required = |key: &str| read_credential(key).unwrap_or_else(|e| panic!("{e}"));

    // KEYCLOAK_URL / KEYCLOAK_REALM are already required by Config::from_env; they are
    // read here through the same accessor so a missing one is reported the same way.
    let keycloak_url = required("KEYCLOAK_URL");
    let realm = required("KEYCLOAK_REALM");
    let client_id = required("E2E_ROPC_CLIENT_ID");
    let client_secret = required("E2E_ROPC_CLIENT_SECRET");
    let username = required("E2E_TEST_USER");
    let password = required("E2E_TEST_PASSWORD");

    let endpoint = format!(
        "{}/realms/{}/protocol/openid-connect/token",
        keycloak_url.trim_end_matches('/'),
        realm
    );

    let response = reqwest::Client::new()
        .post(&endpoint)
        .form(&[
            ("grant_type", "password"),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("username", username.as_str()),
            ("password", password.as_str()),
        ])
        .send()
        .await
        .unwrap_or_else(|e| {
            panic!(
                "could not reach the Keycloak token endpoint at {endpoint}: {e}. \
                 Is the auth stack up? Refusing to run: without a real credential the \
                 authenticated authorization tests would prove nothing."
            )
        });

    let status = response.status();
    assert!(
        status.is_success(),
        "the Keycloak token endpoint at {endpoint} refused the ROPC grant with {status}. \
         Check E2E_ROPC_CLIENT_ID / E2E_ROPC_CLIENT_SECRET / E2E_TEST_USER / \
         E2E_TEST_PASSWORD against the realm. (The response body is deliberately not \
         shown — it can carry credential material.)"
    );

    let body: serde_json::Value = response
        .json()
        .await
        .unwrap_or_else(|e| panic!("the token response from {endpoint} was not JSON: {e}"));

    let access_token = body
        .get("access_token")
        .and_then(|t| t.as_str())
        .unwrap_or_else(|| {
            panic!("the token response from {endpoint} carried no `access_token` field")
        })
        .to_string();

    let subject = subject_from_access_token(&access_token)
        .unwrap_or_else(|e| panic!("could not read the subject from the minted token: {e}"));

    TestIdentity {
        access_token,
        subject,
    }
}

/// Read a required credential from the process environment.
///
/// `Err` names **the variable** so a misconfigured run says which one is missing —
/// never the value. An empty value is treated as missing: a blank secret is a
/// misconfiguration, and letting it through would surface as an opaque 401 from
/// Keycloak instead of a named cause.
///
/// Pure (takes the key, returns a `Result`) so the fail-hard *message* can be asserted
/// without mutating process env mid-suite, which would race every other test in the
/// binary. Testing this is how FR-007 becomes executable.
pub fn read_credential(key: &str) -> Result<String, String> {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => Ok(value),
        _ => Err(format!(
            "{key} is not set (or is empty). It must be set for the authenticated \
             authorization tests — see backend/mc-service/.env.local."
        )),
    }
}

/// Decode a JWT payload segment and extract `sub`. **No signature verification** — the
/// token's authenticity is proven by the service accepting it, which is what the US2
/// control test asserts.
///
/// Pure, for the same reason as [`read_credential`]. Each `Err` names which step failed
/// (segment / decode / parse / missing claim) and never echoes the token itself.
pub fn subject_from_access_token(jwt: &str) -> Result<String, String> {
    let payload = jwt
        .split('.')
        .nth(1)
        .ok_or_else(|| "could not read the token's payload segment: not a dotted JWT".to_string())?;

    // Keycloak emits unpadded base64url, per RFC 7515 §2.
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|e| format!("could not base64url-decode the token's payload segment: {e}"))?;

    let claims: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|e| format!("could not parse the token's payload segment as JSON: {e}"))?;

    claims
        .get("sub")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "the token's payload segment has no `sub` claim".to_string())
}
