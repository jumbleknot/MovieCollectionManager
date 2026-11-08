/**
 * Sign a test member in to the BFF the way a member signs in (feature 085, FR-009).
 *
 * Authorization code + PKCE against the REAL Keycloak login pages, then the BFF's own
 * `POST /bff-api/auth/login` — the same exchange the app performs — so every integration test
 * authenticates through a real server-side session rather than by presenting a token to the BFF.
 * The bearer path this replaces no longer exists in any environment.
 *
 * The login rate limit is per trusted client IP. The integration BFF runs without `TRUSTED_PROXY`,
 * so the limiter has no client identity and skips (measured: specs/085-bff-auth-fail-closed/baseline.md).
 */
import { createHash, randomBytes } from 'node:crypto';

import { cookieHeaderFrom, createBffClient } from './bff-test-server';
import { walkStepUpLogin } from './keycloak-browser-flow';
import { assignRole, getTestTokens, removeRole } from './keycloak-test-client';
import { createSession } from '@/bff-server/session-manager';
import { tokensFromGrant } from '@/bff-server/session-tokens';

const BFF = process.env.BFF_BASE_URL ?? 'http://localhost:8081';

export interface BffSession {
  /** The `Cookie` request header carrying the session (and, before server-held tokens, the token cookies). */
  cookie: string;
  /** The raw `Set-Cookie` lines the login answered with. */
  setCookies: string[];
}

const base64url = (buf: Buffer) => buf.toString('base64url');

/** Sign `username` in through Keycloak's browser flow and the BFF login route. */
export async function loginSession(username: string, password: string): Promise<BffSession> {
  const bff = createBffClient();
  // Registers `${BFF}/auth-callback` on the login client, exactly as the app does on mount.
  await bff.get('/bff-api/auth/init');

  const redirectUri = `${BFF}/auth-callback`;
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

  const { code } = await walkStepUpLogin({
    username,
    password,
    redirectUri,
    codeChallenge,
    forceReauthentication: false,
  });
  if (!code) throw new Error(`loginSession: Keycloak issued no authorization code for ${username}`);

  const res = await bff.post('/bff-api/auth/login', { code, codeVerifier, redirectUri });
  if (res.status !== 200) {
    throw new Error(
      `loginSession: POST /bff-api/auth/login answered ${res.status} for ${username}`,
    );
  }
  return {
    cookie: cookieHeaderFrom(res),
    setCookies: (res.headers['set-cookie'] as string[] | undefined) ?? [],
  };
}

/** Request options that authenticate as `session`. */
export const asSession = (session: BffSession) => ({ headers: { Cookie: session.cookie } });

/**
 * A real session whose member holds NO app role — what a "wrong role gets 403" test needs.
 *
 * Such a member cannot sign in at all (login refuses an account without `mc-user`/`mc-admin`), so
 * the session is established the only way one can come to exist: the member signs in WITH a role,
 * the role is revoked, and the session renews. The renewed server-held token no longer carries
 * the role, so the BFF's role check sees exactly what it would for a member whose role was taken
 * away mid-session (feature 085: there is no bearer shortcut to a role-less token any more).
 */
export async function loginSessionWithoutAppRole(user: {
  userId: string;
  username: string;
  password: string;
}): Promise<BffSession> {
  await assignRole(user.userId, 'mc-user');
  const session = await loginSession(user.username, user.password);
  await removeRole(user.userId, 'mc-user');
  const renewed = await createBffClient().post(
    '/bff-api/auth/refresh',
    {},
    { headers: { Cookie: session.cookie } },
  );
  if (renewed.status !== 200) {
    throw new Error(
      `loginSessionWithoutAppRole: renewal after role removal answered ${renewed.status}`,
    );
  }
  return session;
}

/**
 * A real session created IN-PROCESS, for suites that call a route handler directly (to capture
 * this process's log output) rather than over HTTP.
 *
 * The containerised BFF's sessions live in ITS Redis database and are sealed with ITS key; a
 * handler running in the test process reads the test process's store (db 1) and key, so a session
 * established over HTTP is invisible to it. This creates one through the REAL `createSession`, sealing
 * the member's REAL Keycloak tokens, in the store the in-process handler reads — the same session a
 * login would have produced, minus the HTTP hop.
 */
export async function inProcessSessionCookie(user: {
  username: string;
  password: string;
}): Promise<string> {
  const grant = await getTestTokens(user.username, user.password);
  const payload = JSON.parse(
    Buffer.from(grant.accessToken.split('.')[1]!, 'base64url').toString('utf8'),
  ) as {
    sub: string;
    exp: number;
  };
  const session = await createSession(payload.sub, {
    ...tokensFromGrant({
      access_token: grant.accessToken,
      refresh_token: grant.refreshToken,
      id_token: grant.idToken,
      token_type: 'Bearer',
      expires_in: Math.max(60, payload.exp - Math.floor(Date.now() / 1000)),
      refresh_expires_in: 1800,
      scope: 'openid',
    }),
  });
  return `mcm_session_id=${session.sessionId}`;
}
