/**
 * The member's tokens never leave the server (feature 085 US6 — FR-016..FR-022, SC-007, SC-008).
 *
 * HTTP-level against the running dev BFF + real Keycloak + the BFF's Redis (db 0), no mocks. Each
 * scenario is a real member journey: sign in through Keycloak's code + PKCE flow, use the app,
 * outlive the access token, sign out. The only test-side reach into the store is to READ it (is a
 * token readable?) and to age the CLEAR expiry time the data model deliberately leaves editable.
 */
import { randomUUID } from 'node:crypto';

import {
  assignRole,
  createTestUser,
  deleteTestUser,
  ensureRopcAudienceMapper,
  getTestTokens,
  getUserSessions,
  type TestUser,
} from './helpers/keycloak-test-client';
import { createBffClient } from './helpers/bff-test-server';
import { loginSession, type BffSession } from './helpers/bff-session';
import {
  bffAgeSessionAccessToken,
  bffCleanupUser,
  bffCopySessionTokens,
  bffRawSessionValues,
  closeBffRedis,
} from './helpers/bff-redis-client';

const bff = createBffClient();
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

const sessionIdOf = (s: BffSession): string =>
  s.setCookies.map((c) => c.split(';')[0]!).find((p) => p.startsWith('mcm_session_id='))!.slice('mcm_session_id='.length);

describe('server-held tokens (feature 085 US6, real stack)', () => {
  let member: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    member = await createTestUser('int-custody');
    other = await createTestUser('int-custody-other');
    await assignRole(member.userId, 'mc-user');
    await assignRole(other.userId, 'mc-user');
  });

  afterAll(async () => {
    for (const m of [member, other]) {
      await bffCleanupUser(m.userId).catch(() => {});
      await deleteTestUser(m.userId).catch(() => {});
    }
    await closeBffRedis();
  });

  it('sign-in gives the client the session reference and nothing else (AS-1, FR-016, SC-007)', async () => {
    const s = await loginSession(member.username, member.password);
    const live = s.setCookies.filter((c) => !/Max-Age=0/.test(c));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatch(/^mcm_session_id=/);
    for (const c of s.setCookies) expect(c).not.toMatch(JWT);
  });

  it('the store holds no readable token (AS-4, FR-017, SC-008)', async () => {
    const s = await loginSession(member.username, member.password);
    const { record, tokens } = await bffRawSessionValues(sessionIdOf(s));
    expect(record).toBeTruthy();
    expect(tokens).toBeTruthy();
    expect(record).not.toMatch(JWT);
    expect(tokens).not.toMatch(JWT);
  });

  it('an expired access token is renewed by the server; concurrent requests both succeed (AS-2, AS-5)', async () => {
    const s = await loginSession(member.username, member.password);
    const sid = sessionIdOf(s);
    const before = JSON.parse((await bffRawSessionValues(sid)).tokens!) as { accessExpiresAt: number };
    await bffAgeSessionAccessToken(sid);

    const [r1, r2] = await Promise.all([
      bff.get('/bff-api/collections', { headers: { Cookie: s.cookie } }),
      bff.get('/bff-api/collections', { headers: { Cookie: s.cookie } }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    for (const r of [r1, r2]) {
      expect(((r.headers['set-cookie'] as string[] | undefined) ?? []).join(';')).not.toMatch(JWT);
    }

    const after = JSON.parse((await bffRawSessionValues(sid)).tokens!) as { accessExpiresAt: number };
    expect(after.accessExpiresAt).toBeGreaterThan(Date.now());
    expect(after.accessExpiresAt).toBeGreaterThanOrEqual(before.accessExpiresAt);
    // The renewed session keeps working — a second, rotated-away renewal would have ended it.
    expect((await bff.get('/bff-api/auth/user', { headers: { Cookie: s.cookie } })).status).toBe(200);
  });

  it('sign-out revokes the server-held tokens, ends the SSO session, and the reference is refused (AS-3, FR-020)', async () => {
    const s = await loginSession(member.username, member.password);
    const sid = sessionIdOf(s);
    const out = await bff.post('/bff-api/auth/logout', {}, { headers: { Cookie: s.cookie } });
    expect(out.status).toBe(200);

    expect(await bffRawSessionValues(sid)).toEqual({ record: null, tokens: null });
    expect((await bff.get('/bff-api/auth/user', { headers: { Cookie: s.cookie } })).status).toBe(401);
    expect(await getUserSessions(member.userId)).toEqual([]);
  });

  it('a pre-rollout client holding only the old token cookies is refused and cleared, never migrated (AS-6, FR-022)', async () => {
    const { accessToken } = await getTestTokens(member.username, member.password);
    const res = await bff.get('/bff-api/auth/user', {
      headers: { Cookie: `mcm_access_token=${accessToken}; mcm_session_id=${randomUUID()}` },
    });
    expect(res.status).toBe(401);
    const cleared = ((res.headers['set-cookie'] as string[] | undefined) ?? []).map((c) => c.split('=')[0]);
    expect(cleared).toEqual(expect.arrayContaining(['mcm_session_id', 'mcm_access_token', 'mcm_refresh_token']));
  });

  it("a session holding another member's sealed tokens is refused and ended (FR-006 by construction)", async () => {
    const mine = await loginSession(member.username, member.password);
    const theirs = await loginSession(other.username, other.password);
    await bffCopySessionTokens(sessionIdOf(theirs), sessionIdOf(mine));

    const res = await bff.get('/bff-api/auth/user', { headers: { Cookie: mine.cookie } });
    expect(res.status).toBe(401);
    expect((await bffRawSessionValues(sessionIdOf(mine))).record).toBeNull();
  });
});
