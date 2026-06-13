/**
 * /bff-api/agent/import-upload integration tests (014 US2, T035) — FR-006, FR-022.
 *
 * HTTP-level against the running BFF (real Redis, real Keycloak — no mocking). A multipart upload
 * from an mc-user stashes the file bytes under `import:file:<handle>` and remembers a per-user
 * `{handle, filename}` reference (`agent-import-file:<userId>`); the opaque handle is NOT returned
 * to the client. We assert the per-user reference appears in the BFF's Redis (db 0) and that
 * type/auth are enforced. `requireAuth` accepts a raw Bearer token, so a ROPC token drives auth.
 *
 * Covers: FR-006 (upload → stash), FR-022 (reject unsupported type), agent auth guard.
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

function csvUpload(name: string): FormData {
  const form = new FormData();
  const csv = 'Title,Year,Content Type\nThe Matrix,1999,Movie\nDune,2021,Movie\n';
  form.append('file', new Blob([csv], { type: 'text/csv' }), name);
  return form;
}

describe('/bff-api/agent/import-upload — integration (real BFF + Redis + Keycloak)', () => {
  let mcUser: TestUser;
  let noRoleUser: TestUser;
  let mcToken: string;
  let noRoleToken: string;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    mcUser = await createTestUser('int-import');
    await assignRole(mcUser.userId, 'mc-user');
    ({ accessToken: mcToken } = await getTestTokens(mcUser.username, mcUser.password));

    noRoleUser = await createTestUser('int-import-norole');
    ({ accessToken: noRoleToken } = await getTestTokens(noRoleUser.username, noRoleUser.password));
  });

  afterAll(async () => {
    await redis.del(`agent-import-file:${mcUser?.userId}`);
    await deleteTestUser(mcUser?.userId);
    await deleteTestUser(noRoleUser?.userId);
    await redis.quit();
  });

  it('stashes the upload + a per-user handle reference, returns the filename (FR-006)', async () => {
    const res = await bff.post('/bff-api/agent/import-upload', csvUpload('my-films.csv'), {
      headers: { Authorization: `Bearer ${mcToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.data.filename).toBe('my-films.csv');
    // The opaque handle is server-side only — never returned.
    expect(res.data.handle).toBeUndefined();

    // The per-user reference was stashed (handle + filename), so the next /agent/run can bridge it.
    const ref = await redis.get(`agent-import-file:${mcUser.userId}`);
    expect(ref).toBeTruthy();
    const parsed = JSON.parse(ref as string);
    expect(parsed.filename).toBe('my-films.csv');
    expect(typeof parsed.handle).toBe('string');
    expect(parsed.handle.length).toBeGreaterThan(0);
  });

  it('rejects an unsupported file type (FR-022)', async () => {
    const form = new FormData();
    form.append('file', new Blob(['nope'], { type: 'text/plain' }), 'notes.txt');
    const res = await bff.post('/bff-api/agent/import-upload', form, {
      headers: { Authorization: `Bearer ${mcToken}` },
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 with no auth', async () => {
    const res = await bff.post('/bff-api/agent/import-upload', csvUpload('x.csv'));
    expect(res.status).toBe(401);
  });

  it('returns 403 for an authenticated user lacking mc-user', async () => {
    const res = await bff.post('/bff-api/agent/import-upload', csvUpload('x.csv'), {
      headers: { Authorization: `Bearer ${noRoleToken}` },
    });
    expect(res.status).toBe(403);
  });
});
