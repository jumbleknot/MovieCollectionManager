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
    throw new Error(`loginSession: POST /bff-api/auth/login answered ${res.status} for ${username}`);
  }
  return {
    cookie: cookieHeaderFrom(res),
    setCookies: (res.headers['set-cookie'] as string[] | undefined) ?? [],
  };
}

/** Request options that authenticate as `session`. */
export const asSession = (session: BffSession) => ({ headers: { Cookie: session.cookie } });
