use serde::{Deserialize, Serialize};

/// A movie collection owned by a single user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MovieCollection {
    /// MongoDB ObjectId as hex string (None for new, unsaved collections)
    pub id: Option<String>,
    /// Keycloak user UUID of the collection owner
    pub owner_id: String,
    /// Collection name (max 50 chars, non-empty)
    pub name: String,
    /// Optional free-text description
    pub description: Option<String>,
    /// True if this is the user's default collection
    pub is_default: bool,
    /// Access control list (owner entry seeded on creation)
    pub acl: Vec<AclEntry>,
}

/// An access control entry linking a user to a role within a collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AclEntry {
    pub user_id: String,
    pub role: AclRole,
}

/// Roles within a collection's ACL.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AclRole {
    Owner,
    Contributor,
    Viewer,
}

impl MovieCollection {
    /// Create a new (unsaved) collection for the given owner.
    pub fn new(
        owner_id: impl Into<String>,
        name: impl Into<String>,
        description: Option<String>,
    ) -> Self {
        let owner_id = owner_id.into();
        Self {
            id: None,
            owner_id: owner_id.clone(),
            name: name.into(),
            description,
            is_default: false,
            acl: vec![AclEntry {
                user_id: owner_id,
                role: AclRole::Owner,
            }],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // T021

    #[test]
    fn new_collection_has_correct_owner_and_name() {
        let collection = MovieCollection::new("user-abc", "My Movies", None);
        assert_eq!(collection.owner_id, "user-abc");
        assert_eq!(collection.name, "My Movies");
    }

    #[test]
    fn new_collection_is_not_default_by_default() {
        let collection = MovieCollection::new("user-abc", "My Movies", None);
        assert!(!collection.is_default);
    }

    #[test]
    fn new_collection_description_is_optional() {
        let with_desc = MovieCollection::new("u", "N", Some("desc".to_string()));
        assert_eq!(with_desc.description, Some("desc".to_string()));
        let without_desc = MovieCollection::new("u", "N", None);
        assert_eq!(without_desc.description, None);
    }

    #[test]
    fn new_collection_seeds_owner_acl_entry() {
        let collection = MovieCollection::new("user-abc", "My Movies", None);
        assert_eq!(collection.acl.len(), 1);
        assert_eq!(collection.acl[0].user_id, "user-abc");
        assert_eq!(collection.acl[0].role, AclRole::Owner);
    }

    #[test]
    fn new_collection_has_no_id() {
        let collection = MovieCollection::new("user-abc", "My Movies", None);
        assert!(collection.id.is_none());
    }
}
