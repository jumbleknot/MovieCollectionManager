# Contract — test credential helper (`tests/integration/common/auth.rs`)

**Feature**: 046 · This is an **internal test-harness** contract, consumed only by integration test
binaries in `backend/mc-service`. It is not part of the service's public API.

---

## Public surface

```rust
/// A cached bearer access token for the seeded test identity.
pub async fn user_token() -> String;

/// The `sub` claim of the token returned by `user_token()`.
pub async fn user_subject() -> String;
```

Both are `async`, both are cheap after the first call in a process, and both **panic** rather than
return an error — a test harness that cannot authenticate has nothing meaningful left to assert.

### Internal, but deliberately testable

```rust
/// Read a required credential from the process environment.
/// `Err` names the variable — never the value.
fn read_credential(key: &str) -> Result<String, String>;

/// Decode a JWT payload segment and extract `sub`. No signature verification.
fn subject_from_access_token(jwt: &str) -> Result<String, String>;
```

These are pure so the fail-hard *message* can be asserted without mutating process env mid-suite.
Testing them is how FR-007 becomes executable.

---

## Behaviour

| Aspect | Contract |
|---|---|
| Grant | OAuth2 ROPC: `POST {KEYCLOAK_URL}/realms/{KEYCLOAK_REALM}/protocol/openid-connect/token` with `grant_type=password`, `client_id`, `client_secret`, `username`, `password`, form-encoded |
| Transport | `reqwest` — used **only** to reach Keycloak. The service under test is always driven in-process via `tower::ServiceExt::oneshot`. |
| Caching | one token per test **binary**, in a `tokio::sync::OnceCell` holding `{ access_token, subject }` |
| Refresh | none — the suite finishes well inside the token lifetime |
| Env loading | `dotenvy::from_filename("backend/mc-service/.env.local")` then `dotenvy::dotenv()`, both ignoring failure (the working directory differs between a repo-root and a package-root cargo run; `common::test_db()` already does exactly this) |

### Required environment

| Variable | Local source | CI source |
|---|---|---|
| `E2E_ROPC_CLIENT_ID` | `backend/mc-service/.env.local` | literal `mcm-bff-test` on the `docker run` |
| `E2E_ROPC_CLIENT_SECRET` | `backend/mc-service/.env.local` | `$GITHUB_ENV`, minted at stack bring-up |
| `E2E_TEST_USER` | `backend/mc-service/.env.local` | `app-e2e` job env, from repository secrets |
| `E2E_TEST_PASSWORD` | `backend/mc-service/.env.local` | `app-e2e` job env, from repository secrets |

`KEYCLOAK_URL` and `KEYCLOAK_REALM` are already required by `Config::from_env` and are not this
helper's to introduce.

---

## Failure modes — all hard, none silent

| Condition | Behaviour |
|---|---|
| A required variable is unset or empty | Panic naming **that variable** and stating it must be set for the authenticated authorization tests |
| Keycloak unreachable | Panic naming the token endpoint and the underlying transport error |
| Token response is not 2xx | Panic with the **status code** and the endpoint. The response body is not echoed — it can carry credential material |
| Response lacks `access_token`, or the payload will not decode, or `sub` is missing | Panic naming which of the three failed |

There is **no** skip path, **no** conditional gate, and **no** `#[ignore]`. FR-007 requires this, the
041 guard bans a bare `#[ignore]`, and Rust has no skip primitive in any case. Feature 045 established
the principle: a suite passing for the wrong reason is worse than one that does not run.

---

## Prohibitions

- **Never log or print the access token, the client secret, or the password**, including inside a
  panic message or an assertion failure. Messages name variables and endpoints only.
  (Constitution: Sensitive Data Prohibition.)
- **Never use this helper to reach mc-service.** It exists to talk to the identity provider. Driving
  the service over a socket instead of `oneshot` would require binding a port and would break the
  JWKS readiness gate's guarantees.
- **Never bypass `common::build_test_app*`.** Those builders assert that OIDC discovery became
  *operational*; a hand-rolled router would let the suite pass green against a dead Keycloak, which is
  precisely what 045 proved and guarded against.
