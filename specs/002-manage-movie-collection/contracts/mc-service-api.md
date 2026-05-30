# mc-service API Contract

All mc-service REST endpoints are served at `/api/v1/*` (internal Docker network only — not exposed publicly).

The BFF exposes a parallel set of endpoints at `/bff-api/collections/*` (accessible to the React Native client via session cookie auth). The BFF proxies all requests to mc-service, forwarding the user's JWT from the session in the `Authorization: Bearer` header.

**OpenAPI spec**: `api-specs/mc-service-api.yaml`

---

## Authentication

All endpoints require:
```
Authorization: Bearer {jwt}
```
The JWT must carry `mc-user` or `mc-admin` in the `resource_access.movie-collection-manager.roles` claim.

Responses for auth failures:

| Status | Condition |
|--------|-----------|
| 401 | Missing or invalid JWT |
| 403 | Valid JWT but missing required role |

---

## Collections

### GET /api/v1/collections

List all movie collections owned by the authenticated user.

**Response 200**:
```json
{
  "items": [
    {
      "collectionId": "string (ObjectId hex)",
      "name": "string",
      "description": "string | null",
      "isDefault": true,
      "movieCount": 0,
      "createdAt": "ISO 8601",
      "updatedAt": "ISO 8601"
    }
  ]
}
```

---

### POST /api/v1/collections

Create a new movie collection for the authenticated user.

**Request body**:
```json
{
  "name": "string (required, max 50 chars)",
  "description": "string (optional)"
}
```

**Response 201**:
```json
{
  "collectionId": "string (ObjectId hex)",
  "name": "string",
  "description": "string | null",
  "isDefault": false,
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
```

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_INPUT` | Missing or invalid fields |
| 409 | `DUPLICATE_COLLECTION_NAME` | User already owns a collection with this name (case-insensitive) |

---

### GET /api/v1/collections/{collectionId}

Get a single collection's details.

**Response 200**: Same schema as the item in the list response, including `movieCount`.

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 404 | `COLLECTION_NOT_FOUND` | No collection with this ID owned by the user |

---

### PATCH /api/v1/collections/{collectionId}

Edit a collection's name, description, or default flag. Supports partial updates (only provided fields are changed).

**Request body** (all fields optional; at least one required):
```json
{
  "name": "string (max 50 chars)",
  "description": "string | null",
  "isDefault": true
}
```

> Setting `isDefault: true` atomically clears the previous default collection. Setting `isDefault: false` on the current default is allowed and results in no collection being default.

**Response 200**: Updated collection object (same schema as GET response).

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_INPUT` | No updatable fields provided, or name too long |
| 404 | `COLLECTION_NOT_FOUND` | No collection with this ID owned by the user |
| 409 | `DUPLICATE_COLLECTION_NAME` | Another collection with the new name already exists |

---

### DELETE /api/v1/collections/{collectionId}

Permanently delete a collection and all its movies. Irreversible.

**Response 204**: No content.

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 404 | `COLLECTION_NOT_FOUND` | No collection with this ID owned by the user |

---

## Movies

### GET /api/v1/collections/{collectionId}/movies

List movies in a collection with infinite scroll pagination, optional free-text search, and optional filters.

**Query parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `cursor` | string? | Base64-encoded ObjectId of last seen movie; omit for first page |
| `search` | string? | Free-text search across title, originalTitle, directors, actors, movieSet, tags, outline, plot |
| `contentType` | string? | Filter: `Movie` \| `Series` \| `Concert` |
| `genre` | string? | Filter: exact genre value (repeat for OR — any genre match) |
| `childrens` | boolean? | Filter: `true` or `false` |
| `rated` | string? | Filter: USA rating value |
| `language` | string? | Filter: primary language value |
| `decade` | integer? | Filter: decade start year (e.g., `1980` matches 1980–1989 inclusive) |
| `owned` | boolean? | Filter: `true` or `false` |
| `ownedMedia` | string? | Filter: media type (repeat for OR) |
| `ripped` | boolean? | Filter: `true` or `false` |
| `ripQuality` | string? | Filter: rip quality value (repeat for OR) |

**Response 200**:
```json
{
  "items": [
    {
      "movieId": "string (ObjectId hex)",
      "collectionId": "string (ObjectId hex)",
      "title": "string",
      "year": 1999,
      "contentType": "Movie",
      "language": "English",
      "owned": true,
      "ripped": false,
      "childrens": false,
      "ownedMedia": ["Blu-Ray"],
      "ripQuality": [],
      "genres": ["Drama"],
      "rated": "R",
      "directors": ["David Fincher"],
      "actors": [],
      "tags": [],
      "movieSet": null,
      "originalTitle": null,
      "releaseDate": null,
      "outline": null,
      "plot": null,
      "runtime": null,
      "externalIds": [],
      "createdAt": "ISO 8601",
      "updatedAt": "ISO 8601"
    }
  ],
  "nextCursor": "string | null"
}
```

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 404 | `COLLECTION_NOT_FOUND` | No collection with this ID owned by the user |

---

### POST /api/v1/collections/{collectionId}/movies

Add a new movie to a collection.

**Request body**:
```json
{
  "title": "string (required)",
  "year": 1999,
  "contentType": "Movie",
  "language": "English",
  "owned": true,
  "ripped": false,
  "childrens": false,
  "externalIds": [
    { "system": "IMDB", "uniqueId": "tt0137523", "url": "https://www.imdb.com/title/tt0137523/" }
  ],
  "originalTitle": null,
  "releaseDate": "1999-10-15",
  "outline": null,
  "plot": null,
  "runtime": 139,
  "rated": "R",
  "directors": ["David Fincher"],
  "actors": ["Brad Pitt", "Edward Norton"],
  "movieSet": null,
  "tags": [],
  "genres": ["Drama", "Thriller"],
  "ownedMedia": ["Blu-Ray"],
  "ripQuality": []
}
```

**Response 201**: Created movie object (same full schema as list item).

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_INPUT` | Missing required fields or invalid enum values |
| 400 | `OWNED_MEDIA_WHEN_NOT_OWNED` | ownedMedia provided but owned is false |
| 400 | `RIP_QUALITY_WHEN_NOT_RIPPED` | ripQuality provided but ripped is false |
| 404 | `COLLECTION_NOT_FOUND` | No collection with this ID owned by the user |
| 409 | `DUPLICATE_MOVIE` | Movie with same title, year, and contentType already exists in this collection |

---

### GET /api/v1/collections/{collectionId}/movies/{movieId}

Get full details for a single movie.

**Response 200**: Full movie object (same schema as list item).

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 404 | `COLLECTION_NOT_FOUND` | No collection with this ID owned by the user |
| 404 | `MOVIE_NOT_FOUND` | No movie with this ID in this collection |

---

### PUT /api/v1/collections/{collectionId}/movies/{movieId}

Replace all attributes of an existing movie. Full replacement (all fields required).

**Request body**: Same schema as POST request body.

**Response 200**: Updated movie object.

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_INPUT` | Missing required fields or invalid enum values |
| 400 | `OWNED_MEDIA_WHEN_NOT_OWNED` | ownedMedia provided but owned is false |
| 400 | `RIP_QUALITY_WHEN_NOT_RIPPED` | ripQuality provided but ripped is false |
| 404 | `COLLECTION_NOT_FOUND` | No collection with this ID owned by the user |
| 404 | `MOVIE_NOT_FOUND` | No movie with this ID in this collection |
| 409 | `DUPLICATE_MOVIE` | Updated title/year/contentType conflicts with another movie in this collection |

---

### DELETE /api/v1/collections/{collectionId}/movies/{movieId}

Permanently delete a movie from a collection. Irreversible.

**Response 204**: No content.

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 404 | `COLLECTION_NOT_FOUND` | No collection with this ID owned by the user |
| 404 | `MOVIE_NOT_FOUND` | No movie with this ID in this collection |

---

## Filter Discovery

### GET /api/v1/collections/{collectionId}/movies/filter-options

Return distinct values for dynamic filter options (genre, rated, language, decade) as present in the collection. Used to populate filter UI panels (FR-024).

**Response 200**:
```json
{
  "genres": ["Action", "Drama"],
  "ratings": ["PG-13", "R"],
  "languages": ["English", "French"],
  "decades": [1980, 1990, 2000]
}
```

---

## BFF-Facing Endpoints

The BFF exposes these routes to the React Native client (session cookie auth, not JWT directly):

| BFF Route | Maps to mc-service |
|-----------|-------------------|
| `GET /bff-api/collections` | `GET /api/v1/collections` |
| `POST /bff-api/collections` | `POST /api/v1/collections` |
| `GET /bff-api/collections/[id]` | `GET /api/v1/collections/{id}` |
| `PATCH /bff-api/collections/[id]` | `PATCH /api/v1/collections/{id}` |
| `DELETE /bff-api/collections/[id]` | `DELETE /api/v1/collections/{id}` |
| `GET /bff-api/collections/[id]/movies` | `GET /api/v1/collections/{id}/movies` (+ all query params) |
| `POST /bff-api/collections/[id]/movies` | `POST /api/v1/collections/{id}/movies` |
| `GET /bff-api/collections/[id]/movies/filter-options` | `GET /api/v1/collections/{id}/movies/filter-options` |
| `GET /bff-api/collections/[id]/movies/[movieId]` | `GET /api/v1/collections/{id}/movies/{movieId}` |
| `PUT /bff-api/collections/[id]/movies/[movieId]` | `PUT /api/v1/collections/{id}/movies/{movieId}` |
| `DELETE /bff-api/collections/[id]/movies/[movieId]` | `DELETE /api/v1/collections/{id}/movies/{movieId}` |

---

## Error Response Format

All error responses follow RFC 9457 Problem Details:
```json
{
  "type": "https://mcm.example.com/errors/duplicate-collection-name",
  "title": "Collection name already exists",
  "status": 409,
  "detail": "A collection named 'Sci-Fi' already exists for this user.",
  "instance": "/api/v1/collections"
}
```
