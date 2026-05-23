# Data Model: Manage Movie Collection

**Branch**: `002-manage-movie-collection` | **Date**: 2026-05-22

**Database**: MongoDB 8.x | **Database name**: `mc_db` | **Host (Docker)**: `mc-db`

---

## Collections

### `movie_collections`

Stores all movie collection records for all users. Each document represents one collection owned by one user.

```bson
{
  "_id":         ObjectId,      // system-generated unique identifier (collectionId)
  "ownerId":     String,        // Keycloak userId (UUID) of the collection creator
  "name":        String,        // required, max 50 characters
  "description": String | null, // optional free-text description
  "isDefault":   Boolean,       // true if this is the user's default collection; defaults to false
  "acl": [                      // Access Control List; for future sharing (currently only owner entry)
    {
      "userId": String,         // Keycloak userId
      "role":   String          // "owner" | "contributor" | "viewer"
    }
  ],
  "createdAt":   DateTime,      // UTC ISO 8601
  "updatedAt":   DateTime       // UTC ISO 8601
}
```

**Validation rules** (enforced by Domain-Layer and Adapters-Layer):
- `name` is required and must not exceed 50 characters
- `name` must be unique per `ownerId` (case-insensitive)
- At most one document per `ownerId` may have `isDefault: true`

**Indexes**:

| Index | Fields | Options | Purpose |
|-------|--------|---------|---------|
| Unique name per owner | `{ ownerId: 1, name: 1 }` | unique, collation `{ locale: "en", strength: 2 }` | Enforces FR-004 (case-insensitive duplicate name rejection) |
| Default lookup | `{ ownerId: 1, isDefault: 1 }` | — | Efficient login redirect (FR-009) and default management (FR-006) |
| Owner listing | `{ ownerId: 1, _id: 1 }` | — | Cursor-based pagination of collections list |

---

### `movies`

Stores all movie records across all collections. Each document belongs to exactly one collection.

```bson
{
  "_id":           ObjectId,      // system-generated unique identifier (movieId)
  "collectionId":  ObjectId,      // references movie_collections._id
  "ownerId":       String,        // denormalized from collection; Keycloak userId for access control
  "title":         String,        // required; current movie title
  "year":          Int32,         // required; 4-digit original release year
  "contentType":   String,        // required; "Movie" | "Series" | "Concert"
  "language":      String,        // required; primary language of the movie
  "owned":         Boolean,       // required; true if the user owns this movie
  "ripped":        Boolean,       // required; true if the user has ripped this movie; defaults to false
  "childrens":     Boolean,       // required; true if the movie is for children; defaults to false
  "externalIds": [                // zero or more external identifiers
    {
      "system":   String,         // required; e.g., "IMDB", "TMDB"
      "uniqueId": String,         // required; identifier within the external system
      "url":      String | null   // optional; URL to the movie in that system
    }
  ],
  "originalTitle": String | null, // optional; title in original language if different from title
  "releaseDate":   String | null, // optional; YYYY-MM-DD format
  "outline":       String | null, // optional; brief outline
  "plot":          String | null, // optional; brief plot description
  "runtime":       Int32 | null,  // optional; duration in minutes
  "rated":         String | null, // optional; "G" | "PG" | "PG-13" | "R" | "NC-17" | "NR" | "Unrated"
  "directors":     [String],      // zero or more director names
  "actors":        [String],      // zero or more actor names
  "movieSet":      String | null, // optional; movie set/franchise name
  "tags":          [String],      // zero or more tags
  "genres":        [String],      // zero or more genres
  "ownedMedia":    [String],      // zero or more; "DVD" | "Blu-Ray" | "Blu-Ray 3D" | "UHD Blu-Ray"
  "ripQuality":    [String],      // zero or more; "DVD" | "Blu-Ray" | "Blu-Ray 3D" | "UHD Blu-Ray"
  "createdAt":     DateTime,      // UTC ISO 8601
  "updatedAt":     DateTime       // UTC ISO 8601
}
```

**Validation rules** (enforced by Domain-Layer and Application-Layer):
- `title`, `year`, `contentType`, `language`, `owned`, `ripped`, `childrens` are required
- `contentType` must be one of: `Movie`, `Series`, `Concert`
- `rated` must be one of the allowed values when present: `G`, `PG`, `PG-13`, `R`, `NC-17`, `NR`, `Unrated`
- `ownedMedia` values must each be one of: `DVD`, `Blu-Ray`, `Blu-Ray 3D`, `UHD Blu-Ray`
- `ripQuality` values must each be one of: `DVD`, `Blu-Ray`, `Blu-Ray 3D`, `UHD Blu-Ray`
- `ownedMedia` must be empty when `owned` is `false`
- `ripQuality` must be empty when `ripped` is `false`
- `year` is a 4-digit positive integer (1000–9999)
- `releaseDate` must match `YYYY-MM-DD` format when present
- Within a collection, `(title, year, contentType)` must be unique (case-insensitive on `title`)
- External identifier `(system, uniqueId)` pairs must be unique within a single movie

**Indexes**:

| Index | Fields | Options | Purpose |
|-------|--------|---------|---------|
| Unique movie per collection | `{ collectionId: 1, title: 1, year: 1, contentType: 1 }` | unique, collation `{ locale: "en", strength: 2 }` | Enforces FR-016a |
| Cursor pagination | `{ collectionId: 1, _id: 1 }` | — | Infinite scroll list (FR-018a) |
| Owner access control | `{ collectionId: 1, ownerId: 1 }` | — | Access control verification |
| Text search | `{ title: "text", originalTitle: "text", directors: "text", actors: "text", movieSet: "text", tags: "text", outline: "text", plot: "text" }` | weights per field | FR-021 free-text search |
| Year (decade filter) | `{ collectionId: 1, year: 1 }` | — | FR-022 decade filter |
| ContentType filter | `{ collectionId: 1, contentType: 1 }` | — | FR-022 |
| Genre filter | `{ collectionId: 1, genres: 1 }` | — | FR-022 |
| Language filter | `{ collectionId: 1, language: 1 }` | — | FR-022 |
| Rated filter | `{ collectionId: 1, rated: 1 }` | — | FR-022 |
| Owned filter | `{ collectionId: 1, owned: 1 }` | — | FR-022 |
| OwnedMedia filter | `{ collectionId: 1, ownedMedia: 1 }` | — | FR-022 |
| Ripped filter | `{ collectionId: 1, ripped: 1 }` | — | FR-022 |
| RipQuality filter | `{ collectionId: 1, ripQuality: 1 }` | — | FR-022 |
| Childrens filter | `{ collectionId: 1, childrens: 1 }` | — | FR-022 |

> **Note**: MongoDB can only use one index per query for the main filter. When multiple filters are active simultaneously, MongoDB will choose the most selective index and apply remaining filters in memory. For SC-006 performance targets (3 seconds for 10K movies), the `{ collectionId, _id }` pagination index combined with in-memory filter application is acceptable for typical collections. If performance monitoring reveals bottlenecks on specific filter combinations, compound indexes should be added post-launch.

---

## Domain Enumerations

These are enforced as Rust enum types in the Domain-Layer and validated by the Specification Pattern.

```
ContentType:  Movie | Series | Concert
MediaFormat:  DVD | Blu-Ray | Blu-Ray 3D | UHD Blu-Ray    (used for ownedMedia and ripQuality)
USARating:    G | PG | PG-13 | R | NC-17 | NR | Unrated
AclRole:      owner | contributor | viewer
```

---

## Pagination Contract

The movie list API uses cursor-based pagination. The cursor is the Base64-encoded string of the last document's `_id` (ObjectId hex string).

**Request parameters** (query string):
```
cursor: String?   // base64(objectId hex) of last seen movie; omit for first page
limit:  i32       // items per page; fixed at 50 server-side (client hint ignored)
```

**Response envelope** (all movie list responses):
```json
{
  "items": [...],           // array of movie objects (up to 50)
  "nextCursor": "..."  // base64 cursor for next page; null if no more results
}
```

When a search or filter is active, the cursor is scoped to the same query parameters — the cursor is only valid for the same search+filter combination that produced it.

---

## State Transitions

### Movie Collection Default Flag

Only one collection per user may have `isDefault: true`. The transition is atomic:

1. Find the current default collection for `ownerId` (if any)
2. Set its `isDefault` to `false`
3. Set the target collection's `isDefault` to `true`

Implemented in the `SetDefaultCollection` command handler using a MongoDB session transaction.

### Movie `owned` / `ownedMedia` / `ripped` / `ripQuality` Cross-field Invariants

- If `owned` is set to `false`: `ownedMedia` must be cleared to empty array
- If `ripped` is set to `false`: `ripQuality` must be cleared to empty array

These invariants are enforced by the Domain-Layer `Movie` entity on every mutation.
