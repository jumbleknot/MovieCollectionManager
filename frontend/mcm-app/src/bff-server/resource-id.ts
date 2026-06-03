/**
 * Resource identifier validation for BFF proxy routes (009 finding #10, FR-017).
 *
 * mc-service resource ids are MongoDB ObjectIds (24 hex chars). Validating the
 * format at the BFF boundary — before interpolating into the upstream URL —
 * rejects path/parameter-smuggling attempts (separators, encoded separators,
 * query characters) with a clean 400 and prevents any unintended upstream call.
 */
import { AuthError, AuthErrorCode } from '@/types/errors';

// Safe path-segment characters only. We intentionally do NOT require strict
// 24-hex ObjectId format here: Expo Router routes some legitimate sub-paths
// (e.g. `…/movies/filter-options`) through the dynamic `[movieId]` handler, so a
// strict format check would 400 them and break the screen. The actual goal of
// 009 finding #10 / FR-017 is to block path/parameter smuggling (separators,
// encoded separators, query characters, traversal) — this whitelist does that
// while letting well-formed-but-unknown ids reach mc-service, which returns a
// 404 (matching prior behavior).
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Throw a 400 AuthError when `id` contains unsafe characters (path/query
 * smuggling or traversal). `handleMcApiError` maps it to a 400 response.
 */
export function validateObjectId(id: string, field = 'id'): void {
  if (!SAFE_ID.test(id)) {
    throw new AuthError(AuthErrorCode.INVALID_INPUT, `Invalid ${field}`, 400);
  }
}
