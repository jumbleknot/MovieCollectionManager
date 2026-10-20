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

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
            .collect()
    }

    /// 081 US9 PR 9a: the exact bytes **bson 2.15.0** wrote for a collection with a null
    /// description and a two-entry ACL — generated once from bson 2.15.0 with this struct's
    /// definition. Existing documents must decode and a re-write must be byte-identical.
    const BSON2_COLLECTION_HEX: &str = "\
        dc000000075f69640065f0c0ffee0000000000c011026f776e6572496400080000006f776e65722d3100026e616d6500\
        0a0000004661766f7269746573000a6465736372697074696f6e0008697344656661756c7400010461636c0059000000\
        033000290000000275736572496400080000006f776e65722d310002726f6c6500060000006f776e6572000003310025\
        00000002757365724964000300000075320002726f6c6500070000007669657765720000000963726561746564417400\
        7b68e5cf8b01000009757064617465644174007b68e5cf8b01000000\
    ";

    #[test]
    fn decodes_a_collection_written_by_bson_2_and_rewrites_identical_bytes() {
        let bytes = unhex(BSON2_COLLECTION_HEX);
        let dao: CollectionDao = bson::deserialize_from_slice(&bytes).expect("bson-2 bytes decode");
        assert_eq!(dao.id.unwrap().to_hex(), "65f0c0ffee0000000000c011");
        assert_eq!(dao.name, "Favorites");
        assert_eq!(dao.description, None);
        assert!(dao.is_default);
        assert_eq!(dao.acl.len(), 2);
        assert_eq!(dao.acl[1].role, "viewer");
        assert_eq!(dao.created_at.timestamp_millis(), 1_700_000_000_123);

        let rewritten = bson::serialize_to_vec(&dao).expect("serialize");
        assert_eq!(rewritten, bytes, "bson 3 writes the bytes bson 2 wrote");
        let raw = bson::serialize_to_raw_document_buf(&dao).expect("raw serialize");
        assert_eq!(
            raw.as_bytes(),
            bytes.as_slice(),
            "the driver's insert path too"
        );
    }
}
