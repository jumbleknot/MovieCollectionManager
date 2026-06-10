/**
 * OpenSearch audit-sink integration test (T076c / Finding 1).
 *
 * Verifies that the BFF `postAuditDoc` helper actually lands a document in the
 * `mcm-agent-audit` OpenSearch index when `OPENSEARCH_INSECURE_TLS=true` and the
 * URL is https://localhost:9200 (self-signed cert).
 *
 * Prerequisites (docker compose --profile audit up -d):
 *   OPENSEARCH_URL=https://localhost:9200
 *   OPENSEARCH_USERNAME=agent-audit         (write-only user)
 *   OPENSEARCH_PASSWORD=Mcm-dev-AuditWriter-1!
 *   OPENSEARCH_INSECURE_TLS=true
 *
 * Skips cleanly if OpenSearch is unreachable — the test is opt-in infra (not CI default).
 * Queries as admin (admin/Mcm-dev-Audit-1!) to assert the doc landed; a small https
 * request with rejectUnauthorized:false in the test body is acceptable here (test-only,
 * never production).
 */

import * as nodeHttps from 'node:https';
import { randomUUID } from 'node:crypto';
import { buildAuditDoc, postAuditDoc } from '@/bff-server/audit-sink';

// --- helpers ------------------------------------------------------------------

const OPENSEARCH_URL = (process.env['OPENSEARCH_URL'] ?? 'https://localhost:9200').replace(/\/$/, '');
const IS_HTTPS = OPENSEARCH_URL.startsWith('https://');

/** A tiny https/http JSON requester — test-only; rejectUnauthorized:false for self-signed. */
function httpsRequest(
  method: string,
  url: string,
  authHeader: string,
  body?: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options: nodeHttps.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (IS_HTTPS ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        authorization: authHeader,
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
      rejectUnauthorized: false,
    };
    const mod = IS_HTTPS ? nodeHttps : (require('node:http') as typeof nodeHttps);
    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: null });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function adminAuth(): string {
  const admin = process.env['OPENSEARCH_ADMIN_USER'] ?? 'admin';
  const pass = process.env['OPENSEARCH_ADMIN_PASSWORD'] ?? 'Mcm-dev-Audit-1!';
  return 'Basic ' + Buffer.from(`${admin}:${pass}`).toString('base64');
}

async function isOpenSearchReachable(): Promise<boolean> {
  try {
    const { status } = await httpsRequest('GET', `${OPENSEARCH_URL}/`, adminAuth());
    return status >= 200 && status < 500;
  } catch {
    return false;
  }
}

// Allow time for an index refresh between write and read
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- tests --------------------------------------------------------------------

describe('agent-audit-opensearch — integration (real OpenSearch, --profile audit)', () => {
  let opensearchReachable = false;

  beforeAll(async () => {
    opensearchReachable = await isOpenSearchReachable();
    if (!opensearchReachable) {
      console.warn(
        '[agent-audit-opensearch] OpenSearch unreachable at',
        OPENSEARCH_URL,
        '— skipping all tests in this file.',
      );
    }
  }, 10000);

  it('postAuditDoc lands the doc in mcm-agent-audit over self-signed HTTPS', async () => {
    if (!opensearchReachable) {
      console.warn('SKIP: OpenSearch unreachable');
      return;
    }

    // Set the insecure-TLS env so postAuditDoc takes the node:https path.
    process.env['OPENSEARCH_INSECURE_TLS'] = 'true';
    process.env['OPENSEARCH_URL'] = OPENSEARCH_URL;
    process.env['OPENSEARCH_USERNAME'] = process.env['OPENSEARCH_USERNAME'] ?? 'agent-audit';
    process.env['OPENSEARCH_PASSWORD'] = process.env['OPENSEARCH_PASSWORD'] ?? 'Mcm-dev-AuditWriter-1!';

    // Unique marker so we can find this exact document in the index.
    const marker = `integration-test-${randomUUID()}`;
    const username = process.env['OPENSEARCH_USERNAME'];
    const password = process.env['OPENSEARCH_PASSWORD'];
    const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    const url = `${OPENSEARCH_URL}/mcm-agent-audit/_doc`;
    const body = JSON.stringify({ action: 'integration_test', marker, timestamp: new Date().toISOString() });

    // postAuditDoc reads env at call-time, not at import-time, so the env vars set above
    // take effect even though the module is loaded at import time.
    // postAuditDoc is async — await it directly (testability path).
    await postAuditDoc(url, auth, body);

    // Give OpenSearch a moment to refresh the index.
    await sleep(1500);

    // Query as admin to confirm the doc landed.
    const searchUrl = `${OPENSEARCH_URL}/mcm-agent-audit/_search`;
    // Use `match` (not `term`) — the default dynamic mapping indexes "marker" as text; term
    // queries on text fields never match. The UUID marker is unique enough for match to be exact.
    const searchBody = JSON.stringify({ query: { match: { marker } } });
    const { status, json } = await httpsRequest('POST', searchUrl, adminAuth(), searchBody);

    expect(status).toBe(200);
    const hits = (json as { hits?: { total?: { value?: number } } })?.hits?.total?.value ?? 0;
    expect(hits).toBeGreaterThanOrEqual(1);
  }, 15000);

  it('doc contains action field but no PII/token keys', async () => {
    if (!opensearchReachable) {
      console.warn('SKIP: OpenSearch unreachable');
      return;
    }

    process.env['OPENSEARCH_INSECURE_TLS'] = 'true';
    process.env['OPENSEARCH_URL'] = OPENSEARCH_URL;
    process.env['OPENSEARCH_USERNAME'] = process.env['OPENSEARCH_USERNAME'] ?? 'agent-audit';
    process.env['OPENSEARCH_PASSWORD'] = process.env['OPENSEARCH_PASSWORD'] ?? 'Mcm-dev-AuditWriter-1!';

    const marker = `pii-check-${randomUUID()}`;
    const username = process.env['OPENSEARCH_USERNAME'];
    const password = process.env['OPENSEARCH_PASSWORD'];
    const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    const url = `${OPENSEARCH_URL}/mcm-agent-audit/_doc`;

    // Include sensitive fields — buildAuditDoc should strip them before POST.
    const doc = buildAuditDoc('pii_test', {
      userId: 'u-test-1',
      marker,
      token: 'should-never-land',
      email: 'user@example.com',
      decision: 'approve',
    });
    await postAuditDoc(url, auth, JSON.stringify(doc));

    await sleep(1500);

    const searchUrl = `${OPENSEARCH_URL}/mcm-agent-audit/_search`;
    // Use `match` (not `term`) — the default dynamic mapping indexes "marker" as text; term
    // queries on text fields never match. The UUID marker is unique enough for match to be exact.
    const searchBody = JSON.stringify({ query: { match: { marker } } });
    const { status, json } = await httpsRequest('POST', searchUrl, adminAuth(), searchBody);

    expect(status).toBe(200);
    const hits = (json as { hits?: { hits?: Array<{ _source?: Record<string, unknown> }> } })?.hits?.hits ?? [];
    expect(hits.length).toBeGreaterThanOrEqual(1);

    const source = hits[0]?._source ?? {};
    expect(source['action']).toBe('pii_test');
    expect(source['userId']).toBe('u-test-1');
    expect(source['decision']).toBe('approve');
    // Sensitive keys must not appear — buildAuditDoc strips them before the doc is sent.
    expect(source).not.toHaveProperty('token');
    expect(source).not.toHaveProperty('email');
  }, 15000);
});
