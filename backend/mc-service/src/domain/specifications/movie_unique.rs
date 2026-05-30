/// Movie uniqueness within a collection is enforced at the MongoDB index level
/// using a compound collation index on `{ collectionId, title, year, contentType }`.
/// This placeholder spec documents the invariant at the application layer.
/// The actual enforcement is in the Adapters layer (E11000 → DuplicateMovie).
pub struct MovieUniqueInCollectionSpec;
