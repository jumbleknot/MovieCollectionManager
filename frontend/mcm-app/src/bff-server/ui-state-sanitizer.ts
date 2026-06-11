/**
 * UI-state sanitizer (T026) — the SOLE sanitization point for readable UI state.
 *
 * The client pushes a readable UI snapshot (T057, `bff-api/agent/ui-state`) so the agent
 * can resolve "this" (US3). Before any of it reaches a prompt or the LangGraph checkpoint,
 * the BFF reduces it to an ALLOWLIST of structural fields — never user-entered values, free
 * text, or PII (data-model "UiStateSnapshot"; FR-013/FR-016, constitution §Agent Security).
 *
 * Anything not on the allowlist is dropped; ids that are not well-formed Mongo ObjectIds and
 * screens/filter-keys outside the known structural sets are rejected, so no attacker- or
 * value-bearing string can ride this channel into the model context.
 */

/** Known app screens the agent may be told the user is on (structural labels only). */
const ALLOWED_SCREENS = ['home', 'collection', 'movie-detail', 'profile'] as const;

/** Structural filter DIMENSIONS only — never their values (FR-016). */
const ALLOWED_FILTER_KEYS = [
  'search',
  'genre',
  'decade',
  'owned',
  'ripped',
  'childrens',
  'rated',
  'language',
  'contentType',
  'ownedMedia',
  'ripQuality',
] as const;

const OBJECT_ID = /^[0-9a-f]{24}$/;

export interface SanitizedUiState {
  current_screen: string;
  collection_id: string | null;
  movie_id: string | null;
  active_filter_keys: string[];
  nav_depth: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeObjectId(value: unknown): string | null {
  return typeof value === 'string' && OBJECT_ID.test(value) ? value : null;
}

function sanitizeScreen(value: unknown): string {
  return typeof value === 'string' && (ALLOWED_SCREENS as readonly string[]).includes(value)
    ? value
    : 'unknown';
}

function sanitizeFilterKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = ALLOWED_FILTER_KEYS as readonly string[];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === 'string' && allowed.includes(entry)) seen.add(entry);
  }
  return [...seen];
}

function sanitizeNavDepth(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Reduce an untrusted UI snapshot to the structural allowlist. Returns `null` when the
 * input is not an object (nothing to sanitize). All output fields are present and typed;
 * unrecognized values fall back to safe defaults (`unknown` screen, `null` ids, `[]`, `0`).
 */
export function sanitizeUiState(raw: unknown): SanitizedUiState | null {
  if (!isRecord(raw)) return null;
  return {
    current_screen: sanitizeScreen(raw.current_screen),
    collection_id: sanitizeObjectId(raw.collection_id),
    movie_id: sanitizeObjectId(raw.movie_id),
    active_filter_keys: sanitizeFilterKeys(raw.active_filter_keys),
    nav_depth: sanitizeNavDepth(raw.nav_depth),
  };
}
