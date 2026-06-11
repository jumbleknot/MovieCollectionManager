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
 *
 * TLS note: when OPENSEARCH_URL is https:// AND `OPENSEARCH_INSECURE_TLS` is truthy,
 * the POST is made with `rejectUnauthorized: false` via Node's `node:https` module so that
 * a dev self-signed cert is accepted. This flag must NEVER be set in production (real CA
 * certs work with the default plain-fetch path). The insecure behaviour is scoped to this
 * one request; `NODE_TLS_REJECT_UNAUTHORIZED` is never touched globally.
 */

import * as nodeHttps from 'node:https';
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
 * Internal helper: POST a single audit document to OpenSearch.
 *
 * Extracted so tests can await it directly (the public `audit()` stays void/fire-and-forget
 * by calling this helper without awaiting).
 *
 * When `OPENSEARCH_INSECURE_TLS` is truthy AND the URL is https, the POST is made via
 * Node's `node:https` module with `rejectUnauthorized: false` so a dev self-signed cert is
 * accepted. All other cases use plain `fetch`. The insecure option is strictly opt-in and
 * scoped to this one request — `NODE_TLS_REJECT_UNAUTHORIZED` is never touched.
 */
export function postAuditDoc(
  url: string,
  auth: string,
  body: string,
): Promise<void> {
  const insecureTls =
    !!(process.env['OPENSEARCH_INSECURE_TLS'] ?? '').trim() &&
    url.startsWith('https://');

  if (insecureTls) {
    // Use node:https with rejectUnauthorized: false — scoped to this request only.
    return new Promise<void>((resolve) => {
      const parsedUrl = new URL(url);
      const options: nodeHttps.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: auth,
          'content-length': Buffer.byteLength(body),
        },
        rejectUnauthorized: false,
      };
      const req = nodeHttps.request(options, () => resolve());
      req.on('error', (err: unknown) => {
        logger.error('audit append failed', { action: 'audit_append', error: err });
        resolve();
      });
      req.write(body);
      req.end();
    });
  }

  // Default: plain fetch (real CA cert, or http URL).
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: auth,
    },
    body,
  })
    .then(() => undefined)
    .catch((err: unknown) =>
      logger.error('audit append failed', { action: 'audit_append', error: err }),
    );
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
  const body = JSON.stringify(buildAuditDoc(action, fields));

  // Fire-and-forget — void the promise so it is never awaited on the response path.
  void postAuditDoc(url, auth, body);
}
