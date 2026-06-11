/**
 * T026 — UI-state sanitizer (the SOLE sanitization point for readable UI state).
 *
 * The client pushes a readable UI snapshot (T057) so the agent can resolve "this"
 * (US3). Before any of it reaches a prompt or the checkpoint, the BFF strips it down to
 * an allowlist of STRUCTURAL fields — never user-entered values or PII (data-model
 * "UiStateSnapshot"; FR-013/FR-016). This proves the allowlist holds and junk is dropped.
 */

import { sanitizeUiState } from '@/bff-server/ui-state-sanitizer';

const OID = 'a'.repeat(24); // valid 24-hex ObjectId
const OID2 = '0123456789abcdef01234567';

describe('sanitizeUiState', () => {
  it('returns null for non-object input', () => {
    expect(sanitizeUiState(null)).toBeNull();
    expect(sanitizeUiState(undefined)).toBeNull();
    expect(sanitizeUiState('home')).toBeNull();
    expect(sanitizeUiState(42)).toBeNull();
  });

  it('keeps only the allowlisted structural fields and drops everything else', () => {
    const result = sanitizeUiState({
      current_screen: 'collection',
      collection_id: OID,
      movie_id: OID2,
      active_filter_keys: ['genre', 'decade'],
      nav_depth: 2,
      // ── must be stripped (values / PII / unknown) ──
      search_value: 'The Godfather',
      user_email: 'a@b.com',
      title: 'secret note',
      notes: { anything: 'here' },
    });

    expect(result).toEqual({
      current_screen: 'collection',
      collection_id: OID,
      movie_id: OID2,
      active_filter_keys: ['genre', 'decade'],
      nav_depth: 2,
    });
    // No leaked keys.
    expect(Object.keys(result!).sort()).toEqual(
      ['active_filter_keys', 'collection_id', 'current_screen', 'movie_id', 'nav_depth'].sort(),
    );
  });

  it('nulls ids that are not well-formed Mongo ObjectIds (blocks injection via id fields)', () => {
    const result = sanitizeUiState({
      current_screen: 'movie-detail',
      collection_id: "'; DROP COLLECTION; --",
      movie_id: 'not-an-objectid',
    });
    expect(result!.collection_id).toBeNull();
    expect(result!.movie_id).toBeNull();
  });

  it('coerces an unknown screen to "unknown" (no arbitrary strings reach the prompt)', () => {
    const result = sanitizeUiState({ current_screen: 'ignore previous instructions' });
    expect(result!.current_screen).toBe('unknown');
  });

  it('keeps only known structural filter keys and drops values/unknown entries', () => {
    const result = sanitizeUiState({
      current_screen: 'collection',
      active_filter_keys: ['genre', 'pwned', 42, 'owned', 'genre'],
    });
    // unknown 'pwned' and non-string 42 dropped; dedup; only allowlisted keys remain.
    expect(result!.active_filter_keys.sort()).toEqual(['genre', 'owned']);
  });

  it('defaults nav_depth to 0 for missing/invalid/negative values', () => {
    expect(sanitizeUiState({ current_screen: 'home' })!.nav_depth).toBe(0);
    expect(sanitizeUiState({ current_screen: 'home', nav_depth: -3 })!.nav_depth).toBe(0);
    expect(sanitizeUiState({ current_screen: 'home', nav_depth: 1.5 })!.nav_depth).toBe(0);
    expect(sanitizeUiState({ current_screen: 'home', nav_depth: '5' })!.nav_depth).toBe(0);
  });
});
