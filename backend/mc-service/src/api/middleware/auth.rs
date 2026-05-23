use std::fmt;

use axum_keycloak_auth::{
    instance::KeycloakAuthInstance, layer::KeycloakAuthLayer, PassthroughMode,
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
///   route-level checks in handlers via `KeycloakToken<Role>` extensions.
///
/// This layer is applied to the `protected` sub-router in `router.rs`.
/// Individual handlers use `Extension<KeycloakToken<Role>>` only to *read claims*
/// (e.g., `token.subject`) after the layer has already enforced auth.
/// (constitution: Centralized Access Control)
pub fn build_auth_layer(instance: KeycloakAuthInstance, audience: &str) -> KeycloakAuthLayer<Role> {
    KeycloakAuthLayer::<Role>::builder()
        .instance(instance)
        .passthrough_mode(PassthroughMode::Block)
        .persist_raw_claims(false)
        .expected_audiences(vec![audience.to_string()])
        .build()
}
