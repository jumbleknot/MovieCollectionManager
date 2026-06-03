use std::fmt;

use axum::{
    body::Body, extract::Request, http::StatusCode, middleware::Next, response::Response, Extension,
};
use axum_keycloak_auth::{
    decode::KeycloakToken, instance::KeycloakAuthInstance, layer::KeycloakAuthLayer,
    PassthroughMode,
};
use serde::{Deserialize, Serialize};

/// Roles extracted from the `resource_access.movie-collection-manager.roles` JWT claim.
///
/// Implements `axum_keycloak_auth::role::Role` requirements:
/// - `Debug + Display + Clone + PartialEq + Eq + Send + Sync + From<String>`
#[derive(Debug, Clone, PartialEq, Eq, Hash, Deserialize, Serialize)]
pub enum Role {
    #[serde(rename = "mc-user")]
    McUser,
    #[serde(rename = "mc-admin")]
    McAdmin,
    /// Any role string not matching a known role — preserved for forward compatibility.
    #[serde(untagged)]
    Unknown(String),
}

impl fmt::Display for Role {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Role::McUser => write!(f, "mc-user"),
            Role::McAdmin => write!(f, "mc-admin"),
            Role::Unknown(s) => write!(f, "{s}"),
        }
    }
}

impl From<String> for Role {
    fn from(s: String) -> Self {
        match s.as_str() {
            "mc-user" => Role::McUser,
            "mc-admin" => Role::McAdmin,
            other => Role::Unknown(other.to_string()),
        }
    }
}

// Satisfy the `axum_keycloak_auth::role::Role` marker trait bound.
impl axum_keycloak_auth::role::Role for Role {}

/// Build a `KeycloakAuthLayer` that rejects requests without a valid JWT.
///
/// The `expected_audiences` ensures the JWT was issued for this specific Keycloak client.
///
/// Role enforcement strategy:
/// - We do NOT set `required_roles` here because both `mc-user` AND `mc-admin` roles
///   must independently grant access (OR logic), which the layer's `required_roles`
///   does not support natively (it requires ALL listed roles).
/// - The layer enforces: valid JWT + correct audience. Role presence is validated by
///   `require_app_role` middleware (applied via `from_fn` on the protected sub-router).
///
/// This layer is applied to the `protected` sub-router in `router.rs`.
/// Individual handlers use `Extension<KeycloakToken<Role>>` only to *read claims*
/// (e.g., `token.subject`) after auth and role checks have already been enforced.
/// (constitution: Centralized Access Control)
pub fn build_auth_layer(instance: KeycloakAuthInstance, audience: &str) -> KeycloakAuthLayer<Role> {
    KeycloakAuthLayer::<Role>::builder()
        .instance(instance)
        .passthrough_mode(PassthroughMode::Block)
        .persist_raw_claims(false)
        .expected_audiences(vec![audience.to_string()])
        .build()
}

/// Middleware that enforces application role membership after JWT validation.
///
/// `KeycloakAuthLayer` only verifies the JWT signature and audience — it does not
/// check application-specific roles. This middleware fills that gap by requiring
/// `mc-user` OR `mc-admin` (OR logic) before forwarding the request.
///
/// Applied via `axum::middleware::from_fn` on the protected sub-router, inside
/// `auth_layer`, so auth always runs first.
/// (constitution: Centralized Access Control)
pub async fn require_app_role(
    Extension(token): Extension<KeycloakToken<Role>>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, (StatusCode, axum::Json<serde_json::Value>)> {
    let has_role = token
        .roles
        .iter()
        .any(|r| matches!(*r.role(), Role::McUser | Role::McAdmin));

    if !has_role {
        return Err((
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({
                "type": "https://httpstatuses.io/403",
                "title": "Forbidden",
                "status": 403,
                "detail": "Insufficient permissions: mc-user or mc-admin role required."
            })),
        ));
    }

    Ok(next.run(request).await)
}
