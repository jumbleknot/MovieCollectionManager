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

use crate::common::auth::{read_credential, subject_from_access_token};

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
