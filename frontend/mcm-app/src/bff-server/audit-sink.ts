/**
 * BFF audit sink (T076c) — config-gated, append-only OpenSearch sink.
 *
 * ALWAYS emits `logger.audit(...)` (today's behaviour, unchanged).
 * ALSO, when OPENSEARCH_URL is set, fire-and-forget appends a redacted doc to OpenSearch.
 *
 * Hard constraints:
 *   - Fire-and-forget: the OpenSearch POST is NEVER awaited on the response path.
 *   - Never throws: all errors are swallowed with `.catch` so the route is unaffected.
 *   - Never sends PII or credentials: `buildAuditDoc` strips the same sensitive keys the
 *     BFF logger redacts before the doc is POSTed.
 *   - Additive only: OPENSEARCH_URL unset ⇒ behaviour is exactly today's (log only).
 */

import { logger } from '@/bff-server/logger';

/**
 * Keys that must never appear in the OpenSearch document.
 * Mirrors the BFF logger's SENSITIVE_KEYS set, plus a catch-all for any key
 * whose name contains "token" (case-insensitive).
 */
const REDACT = new Set([
  'token',
  'sessionId', 'session_id',
  'password',
  'secret', 'clientSecret', 'client_secret',
  'cookie',
  'authorization',
  'code', 'codeVerifier', 'code_verifier',
  'email',
  'username',
  // Explicit token variants (also caught by the .includes('token') check below).
  'accessToken', 'refreshToken', 'idToken',
  'id_token', 'access_token', 'refresh_token',
]);

/**
 * Build a redacted audit document safe for external storage.
 * Strips every key in REDACT and every key whose lowercased name contains "token".
 * The `action` field is always included.
 */
export function buildAuditDoc(
  action: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const doc: Record<string, unknown> = { action };
  for (const [k, v] of Object.entries(fields)) {
    if (REDACT.has(k) || k.toLowerCase().includes('token')) continue;
    doc[k] = v;
  }
  return doc;
}

/**
 * Always emits the structured audit log via `logger.audit` (synchronous, original fields
 * passed verbatim — the logger applies its own redaction).
 *
 * When OPENSEARCH_URL is set, ALSO fire-and-forget appends a redacted doc to OpenSearch.
 * The POST is never awaited, never throws, and never delays the route response.
 */
export function audit(action: string, fields: Record<string, unknown>): void {
  // Always log — original fields, logger does its own redaction.
  logger.audit(action, fields);

  const base = (process.env['OPENSEARCH_URL'] ?? '').trim();
  if (!base) return;

  const username = process.env['OPENSEARCH_USERNAME'] ?? '';
  const password = process.env['OPENSEARCH_PASSWORD'] ?? '';
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const url = `${base.replace(/\/$/, '')}/mcm-agent-audit/_doc`;

  // Fire-and-forget — void the promise so it is never awaited on the response path.
  // The .catch ensures this can never throw or cause an unhandled rejection.
  void fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: auth,
    },
    body: JSON.stringify(buildAuditDoc(action, fields)),
  }).catch((err: unknown) =>
    logger.error('audit append failed', { action: 'audit_append', error: err }),
  );
}
