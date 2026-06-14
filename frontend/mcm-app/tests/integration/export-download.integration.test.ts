/**
 * /bff-api/agent/export-download integration tests (014 US3, T046) — FR-028.
 *
 * HTTP-level against the running BFF (real Redis, real Keycloak — no mocking). The export node
 * stores a built workbook under `export:file:<handle>` + `export:name:<handle>`; this route streams
 * it once (single-use) to an authenticated mc-user, with a `Content-Disposition` attachment. We
 * seed those keys directly in the BFF's Redis (db 0) — bypassing the gateway — then exercise the
 * route. `requireAuth` accepts a raw Bearer token, so a ROPC access token drives the auth paths.
 *
 * Covers: US3-AC5, FR-028 (single-use, ownership-by-capability, 404 on expired).
 */
import Redis from 'ioredis';

import {
  createTestUser,
  deleteTestUser,
  getTestTokens,
  assignRole,
  ensureRopcAudienceMapper,
  type TestUser,
} from './helpers/keycloak-test-client';
import { createBffClient } from './helpers/bff-test-server';

const bff = createBffClient();
const redis = new Redis({ host: 'localhost', port: 6379, db: 0 });

const FILE_KEY = (h: string) => `export:file:${h}`;
const NAME_KEY = (h: string) => `export:name:${h}`;

async function seedExport(handle: string, bytes: Buffer, filename: string): Promise<void> {
  await redis.set(FILE_KEY(handle), bytes, 'EX', 600);
  await redis.set(NAME_KEY(handle), Buffer.from(filename, 'utf8'), 'EX', 600);
}

describe('/bff-api/agent/export-download — integration (real BFF + Redis + Keycloak)', () => {
  let mcUser: TestUser;
  let noRoleUser: TestUser;
  let mcToken: string;
  let noRoleToken: string;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    mcUser = await createTestUser('int-export');
    await assignRole(mcUser.userId, 'mc-user');
    ({ accessToken: mcToken } = await getTestTokens(mcUser.username, mcUser.password));

    noRoleUser = await createTestUser('int-export-norole');
    ({ accessToken: noRoleToken } = await getTestTokens(noRoleUser.username, noRoleUser.password));
  });

  afterAll(async () => {
    await deleteTestUser(mcUser?.userId);
    await deleteTestUser(noRoleUser?.userId);
    await redis.quit();
  });

  it('streams the xlsx with a Content-Disposition and is single-use (US3-AC5/FR-028)', async () => {
    const handle = `it-export-${Date.now()}`;
    const bytes = Buffer.from('PK\x03\x04 fake-xlsx-bytes');
    await seedExport(handle, bytes, 'movie-collections-export.xlsx');

    const res = await bff.get(`/bff-api/agent/export-download?handle=${handle}`, {
      headers: { Authorization: `Bearer ${mcToken}` },
      responseType: 'arraybuffer',
    });
    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('spreadsheetml.sheet');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    expect(String(res.headers['content-disposition'])).toContain('.xlsx');
    expect(Buffer.from(res.data).length).toBe(bytes.length);

    // Single-use: the keys are consumed → a second download misses.
    const again = await bff.get(`/bff-api/agent/export-download?handle=${handle}`, {
      headers: { Authorization: `Bearer ${mcToken}` },
    });
    expect(again.status).toBe(404);
    expect(await redis.exists(FILE_KEY(handle))).toBe(0);
  });

  it('returns 404 for an unknown/expired handle', async () => {
    const res = await bff.get('/bff-api/agent/export-download?handle=does-not-exist', {
      headers: { Authorization: `Bearer ${mcToken}` },
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the handle is missing', async () => {
    const res = await bff.get('/bff-api/agent/export-download', {
      headers: { Authorization: `Bearer ${mcToken}` },
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 with no auth', async () => {
    const res = await bff.get('/bff-api/agent/export-download?handle=x');
    expect(res.status).toBe(401);
  });

  it('returns 403 for an authenticated user lacking mc-user', async () => {
    const res = await bff.get('/bff-api/agent/export-download?handle=x', {
      headers: { Authorization: `Bearer ${noRoleToken}` },
    });
    expect(res.status).toBe(403);
  });
});
