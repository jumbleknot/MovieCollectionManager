/**
 * User-facing message for a backups API error (feature 073).
 *
 * WHY THIS EXISTS. The backups routes answer with RFC 9457 Problem Details —
 * `{ type, title, status, detail }` — as mc-service does throughout
 * (openwiki/gotchas/rfc-9457-problem-details.md). The shared `getErrorMessage` understands only
 * the AUTH vocabulary, `{ code }` mapped through AUTH_ERROR_MESSAGES, so every problem response
 * collapsed to "An unexpected error occurred. Please try again."
 *
 * MEASURED by the E2E, and it is not cosmetic: FR-004 and FR-005 exist precisely so a user is
 * told WHICH thing is wrong — the address is not permitted, the credential was rejected, the
 * bucket cannot be written to — and each has a different fix. Discarding that reason turns
 * three actionable outcomes into one dead end. The reasons are already safe by construction:
 * every one is a string this feature constructed, never an upstream body.
 *
 * Scoped to backups rather than fixed inside `getErrorMessage` on purpose. That function backs
 * the auth flows, whose messages are deliberately code-mapped and separately tested, and
 * widening it is a change to shared behaviour that this feature should not make on the way
 * past. The general gap — any RFC 9457 error from a proxied route reads as "unexpected" — is
 * real and worth its own item.
 */
import { getErrorMessage } from '@/utils/errors';

interface ProblemDetails {
  title?: unknown;
  detail?: unknown;
}

export function backupErrorMessage(error: unknown): string {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const problem = data as ProblemDetails;
    // `detail` is the specific, actionable half ("That address is not allowed…"); `title` is
    // the category ("Address not allowed"). Prefer the specific one and fall back.
    if (typeof problem.detail === 'string' && problem.detail.trim() !== '') return problem.detail;
    if (typeof problem.title === 'string' && problem.title.trim() !== '') return problem.title;
  }
  return getErrorMessage(error);
}
