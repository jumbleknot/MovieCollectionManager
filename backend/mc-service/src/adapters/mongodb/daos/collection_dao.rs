use bson::{oid::ObjectId, DateTime};
use serde::{Deserialize, Serialize};

use crate::domain::collection::{AclEntry, AclRole, MovieCollection};

/// BSON document representation of a movie collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionDao {
    #[serde(rename = "_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<ObjectId>,
    #[serde(rename = "ownerId")]
    pub owner_id: String,
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "isDefault")]
    pub is_default: bool,
    pub acl: Vec<AclEntryDao>,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime,
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AclEntryDao {
    #[serde(rename = "userId")]
    pub user_id: String,
    pub role: String,
}

impl From<CollectionDao> for MovieCollection {
    fn from(dao: CollectionDao) -> Self {
        MovieCollection {
            id: dao.id.map(|id| id.to_hex()),
            owner_id: dao.owner_id,
            name: dao.name,
            description: dao.description,
            is_default: dao.is_default,
            acl: dao
                .acl
                .into_iter()
                .map(|a| AclEntry {
                    user_id: a.user_id,
                    role: match a.role.as_str() {
                        "owner" => AclRole::Owner,
                        "contributor" => AclRole::Contributor,
                        _ => AclRole::Viewer,
                    },
                })
                .collect(),
        }
    }
}

impl From<MovieCollection> for CollectionDao {
    fn from(domain: MovieCollection) -> Self {
        let now = DateTime::now();
        CollectionDao {
            id: domain
                .id
                .as_deref()
                .and_then(|s| ObjectId::parse_str(s).ok()),
            owner_id: domain.owner_id,
            name: domain.name,
            description: domain.description,
            is_default: domain.is_default,
            acl: domain
                .acl
                .into_iter()
                .map(|a| AclEntryDao {
                    user_id: a.user_id,
                    role: match a.role {
                        AclRole::Owner => "owner".to_string(),
                        AclRole::Contributor => "contributor".to_string(),
                        AclRole::Viewer => "viewer".to_string(),
                    },
                })
                .collect(),
            created_at: now,
            updated_at: now,
        }
    }
}
