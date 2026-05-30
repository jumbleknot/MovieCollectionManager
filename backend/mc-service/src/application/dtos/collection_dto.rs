use serde::{Deserialize, Serialize};

/// Full collection representation returned to the client.
///
/// Serialized to camelCase JSON per the mc-service API contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionDto {
    /// Serialized as `collectionId` in JSON.
    #[serde(rename = "collectionId")]
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub description: Option<String>,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Summary representation (used in list responses) — includes movie count.
///
/// Serialized to camelCase JSON per the mc-service API contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummaryDto {
    /// Serialized as `collectionId` in JSON.
    #[serde(rename = "collectionId")]
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub is_default: bool,
    pub movie_count: u64,
    pub created_at: String,
    pub updated_at: String,
}

/// Request body for creating a new collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCollectionDto {
    pub name: String,
    pub description: Option<String>,
}

/// Request body for updating an existing collection.
/// All fields are optional — only provided fields are modified.
///
/// Deserializes from camelCase JSON (client sends `isDefault`, `description`, etc.).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCollectionDto {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub is_default: Option<bool>,
}
