/**
 * T020 — TypeScript interfaces for movie collection domain types.
 *
 * These interfaces mirror the mc-service API contract (contracts/mc-service-api.md)
 * and are used in:
 *   - BFF route handlers that proxy between the client and mc-service
 *   - React Native UI components and hooks
 *
 * All types are technology-agnostic (no Axios, no Axum imports).
 */

// ─── Enums (string union types matching mc-service domain enums) ───────────────

export type ContentType = 'Movie' | 'Series' | 'Concert';

// Spec FR-013: owned media and rip quality share the same allowed values.
// Mirrors mc-service domain::MediaFormat (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray).
export type MediaFormat =
  | 'DVD'
  | 'Blu-Ray'
  | 'Blu-Ray 3D'
  | 'UHD Blu-Ray';

// Spec FR-013: rip quality uses the same value set as owned media.
export type RipQuality = MediaFormat;

// Spec clarification 2026-05-22: controlled vocabulary G, PG, PG-13, R, NC-17, NR, Unrated.
// Mirrors mc-service domain::UsaRating.
export type UsaRating = 'G' | 'PG' | 'PG-13' | 'R' | 'NC-17' | 'NR' | 'Unrated';

// ─── Value objects ─────────────────────────────────────────────────────────────

/** External metadata source link (e.g., IMDB, TMDB). */
export interface ExternalId {
  system: string;
  uniqueId: string;
  url?: string | null;
}

// ─── Collection types ──────────────────────────────────────────────────────────

/**
 * Full collection object returned by GET /collections/:id and POST/PATCH responses.
 */
export interface Collection {
  collectionId: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/**
 * Summary collection object returned by GET /collections (list endpoint).
 * Includes movie count but not the full movie list.
 */
export interface CollectionSummary extends Collection {
  movieCount: number;
}

/** Request body for POST /collections. */
export interface CreateCollectionRequest {
  name: string; // required, max 50 chars
  description?: string | null;
}

/** Request body for PATCH /collections/:id (all fields optional). */
export interface UpdateCollectionRequest {
  name?: string | null;
  description?: string | null;
  isDefault?: boolean | null;
}

/** Response body for GET /collections (list). */
export interface CollectionListResponse {
  items: CollectionSummary[];
}

// ─── Movie types ───────────────────────────────────────────────────────────────

/** Full movie object returned by all movie endpoints. */
export interface Movie {
  movieId: string;
  collectionId: string;
  title: string;
  year: number;
  contentType: ContentType;
  language: string;
  owned: boolean;
  ripped: boolean;
  childrens: boolean;
  ownedMedia: MediaFormat[];
  ripQuality: RipQuality[];
  genres: string[];
  rated: UsaRating | null;
  directors: string[];
  actors: string[];
  tags: string[];
  movieSet: string | null;
  originalTitle: string | null;
  releaseDate: string | null; // ISO 8601 date string
  outline: string | null;
  plot: string | null;
  runtime: number | null; // minutes
  externalIds: ExternalId[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** Request body for POST /collections/:id/movies. */
export interface CreateMovieRequest {
  title: string;
  year: number;
  contentType: ContentType;
  language: string;
  owned: boolean;
  ripped: boolean;
  childrens: boolean;
  ownedMedia?: MediaFormat[];
  ripQuality?: RipQuality[];
  genres?: string[];
  rated?: UsaRating | null;
  directors?: string[];
  actors?: string[];
  tags?: string[];
  movieSet?: string | null;
  originalTitle?: string | null;
  releaseDate?: string | null;
  outline?: string | null;
  plot?: string | null;
  runtime?: number | null;
  externalIds?: ExternalId[];
}

/** Request body for PUT /collections/:id/movies/:movieId (full replacement). */
export interface UpdateMovieRequest extends CreateMovieRequest {}

/** Response body for GET /collections/:id/movies (paginated list). */
export interface MovieListResponse {
  items: Movie[];
  nextCursor: string | null; // base64-encoded ObjectId; null = end of list
}

// ─── Filter options ────────────────────────────────────────────────────────────

/**
 * Dynamic filter values present in a collection.
 * Returned by GET /collections/:id/movies/filter-options.
 * Field names mirror the mc-service FilterOptionsDto (camelCase).
 */
export interface FilterOptionsData {
  genres: string[];
  contentTypes: string[];
  rated: string[];
  languages: string[];
  decades: number[];
  ownedMedia: string[];
  ripQuality: string[];
}

/**
 * @deprecated Use FilterOptionsData — kept for backward compatibility.
 */
export interface FilterOptions {
  genres: string[];
  ratings: string[];
  languages: string[];
  decades: number[];
}

// ─── Query parameter types ─────────────────────────────────────────────────────

/** Query parameters accepted by GET /collections/:id/movies. */
export interface MovieListQuery {
  cursor?: string;
  search?: string;
  contentType?: ContentType;
  genre?: string | string[];
  childrens?: boolean;
  rated?: string;
  language?: string;
  decade?: number;
  owned?: boolean;
  ownedMedia?: string | string[];
  ripped?: boolean;
  ripQuality?: string | string[];
}

/** Active filter state for the movie list UI (subset of MovieListQuery, without cursor/search). */
export interface MovieListFilters {
  contentType?: ContentType;
  genre?: string;
  childrens?: boolean;
  rated?: string;
  language?: string;
  decade?: number;
  owned?: boolean;
  ownedMedia?: string;
  ripped?: boolean;
  ripQuality?: string;
}

// ─── Column visibility ─────────────────────────────────────────────────────────

/** Toggleable column keys for the movie list table (title is always shown). */
export type ColumnKey =
  | 'year'
  | 'contentType'
  | 'language'
  | 'owned'
  | 'ripped'
  | 'childrens'
  | 'genres'
  | 'rated'
  | 'ownedMedia'
  | 'ripQuality'
  | 'runtime'
  | 'directors'
  | 'actors';

/** Visibility state for each toggleable column. */
export type ColumnVisibility = Record<ColumnKey, boolean>;
