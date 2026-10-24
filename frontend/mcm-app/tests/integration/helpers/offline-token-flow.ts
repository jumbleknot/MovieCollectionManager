/**
 * Acquire a REAL Keycloak offline refresh token by driving the real authorization-code flow
 * (feature 073, T052 — FR-021/FR-022).
 *
 * WHY THE WHOLE BROWSER ROUND TRIP, in a test. An offline token can only be minted by an
 * authorization-code or direct-grant exchange carrying `scope=offline_access`; there is no
 * admin-API shortcut and RFC 8693 token exchange cannot produce one (it downscopes an access
 * token, it does not issue a refresh token). The two candidate shortcuts both fail for a reason
 * that matters:
 *
 *   - The ROPC test client (`mcm-bff-test`) can mint one, but the token would belong to THAT
 *     client, and Keycloak's revocation endpoint only revokes tokens belonging to the
 *     authenticated client. The BFF revokes as `movie-collection-manager`, so the revocation
 *     under test would silently do nothing and the suite would prove the opposite of what it
 *     claims.
 *   - `movie-collection-manager` has direct access grants DISABLED, deliberately. Enabling them
 *     to make a test easier would weaken the production-shaped client in a shared realm.
 *
 * So the flow is driven as a browser would: authorize → login form → code → exchange. Cookies
 * are carried explicitly because Keycloak's `KC_RESTART` cookie must come back on the login POST
 * or it answers "Restart login cookie not found" with a 400 that looks like a credential error.
 */
import { randomBytes, createHash } from 'node:crypto';

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8099';
const REALM = process.env.KEYCLOAK_REALM ?? 'grumpyrobot';
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? 'movie-collection-manager';
const CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET ?? '';

const TOKEN_ENDPOINT = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`;
const AUTH_ENDPOINT = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/auth`;

/** Already registered on the client, so acquiring a token needs no realm change. */
export const CONSENT_REDIRECT_URI = 'http://localhost:8081/auth-callback';

export class CookieJar {
  private readonly jar = new Map<string, string>();

  absorb(res: Response): void {
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/**
 * Log this user in through the real authorization-code flow and return the offline refresh
 * token the exchange produces. The token's `typ` is asserted by the caller, not here.
 */
export async function acquireOfflineRefreshToken(
  username: string,
  password: string,
  redirectUri: string = CONSENT_REDIRECT_URI,
): Promise<string> {
  const verifier = randomBytes(40).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const jar = new CookieJar();

  const authUrl = `${AUTH_ENDPOINT}?${new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    // The whole point: without `offline_access` the refresh token is an ordinary one, tied to
    // the SSO session and dead the moment the user logs out.
    scope: 'openid offline_access',
    redirect_uri: redirectUri,
    state: randomBytes(8).toString('hex'),
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;

  const page = await fetch(authUrl, { redirect: 'manual' });
  jar.absorb(page);
  const html = await page.text();
  const action = html.match(/<form id="kc-form-login"[^>]*action="([^"]+)"/)?.[1];
  if (!action) throw new Error(`No Keycloak login form at the authorize endpoint (${page.status})`);

  const login = await fetch(action.replace(/&amp;/g, '&'), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
    body: new URLSearchParams({ username, password, credentialId: '' }).toString(),
  });
  const location = login.headers.get('location');
  if (!location) throw new Error(`Keycloak login did not redirect (${login.status})`);
  const code = new URL(location).searchParams.get('code');
  if (!code) {
    // A redirect to `login-actions/required-action` means the user has a pending required
    // action (an incomplete profile is the usual cause) — not a wrong password.
    throw new Error(`No authorization code in the callback: ${location}`);
  }

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Code exchange failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { refresh_token: string }).refresh_token;
}

export interface BrowserSession {
  /** The browser's Keycloak cookies — the SSO session a later authorize request rides on. */
  jar: CookieJar;
  accessToken: string;
  refreshToken: string;
}

/**
 * Sign this user in as the BROWSER does (feature 083 / #702): an ordinary `openid` login on the
 * login client, keeping the cookie jar.
 *
 * The jar is the point. A consent round trip run later in the same jar is answered from the SSO
 * cookie without a login form, so Keycloak attaches its offline grant to THIS session — the
 * situation every real member is in, and the one `acquireOfflineRefreshToken` (a fresh jar, so a
 * separate session) cannot reproduce.
 */
export async function browserLogin(
  username: string,
  password: string,
  redirectUri: string = CONSENT_REDIRECT_URI,
): Promise<BrowserSession> {
  const verifier = randomBytes(40).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const jar = new CookieJar();

  const page = await fetch(
    `${AUTH_ENDPOINT}?${new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      scope: 'openid',
      redirect_uri: redirectUri,
      state: randomBytes(8).toString('hex'),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })}`,
    { redirect: 'manual' },
  );
  jar.absorb(page);
  const action = (await page.text()).match(/<form id="kc-form-login"[^>]*action="([^"]+)"/)?.[1];
  if (!action) throw new Error(`No Keycloak login form at the authorize endpoint (${page.status})`);

  const login = await fetch(action.replace(/&amp;/g, '&'), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
    body: new URLSearchParams({ username, password, credentialId: '' }).toString(),
  });
  jar.absorb(login);
  const code = new URL(login.headers.get('location') ?? 'x:').searchParams.get('code');
  if (!code) throw new Error(`No authorization code in the login callback (${login.status})`);

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Code exchange failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; refresh_token: string };
  return { jar, accessToken: body.access_token, refreshToken: body.refresh_token };
}

/**
 * Follow an authorization URL the BFF built, in an already signed-in jar, and return the code.
 * Keycloak answers from the SSO cookie with a redirect — no login form — exactly as it does for
 * the member who clicks "enable schedule" while signed in.
 */
export async function followAuthorize(jar: CookieJar, authorizationUrl: string): Promise<string> {
  const res = await fetch(authorizationUrl, { redirect: 'manual', headers: { Cookie: jar.header() } });
  jar.absorb(res);
  const location = res.headers.get('location');
  const code = location ? new URL(location).searchParams.get('code') : null;
  if (!code) {
    throw new Error(
      `The authorize request was not answered from the SSO session (${res.status} ${location ?? 'no redirect'})`,
    );
  }
  return code;
}

/** The `typ` claim of a refresh token — `'Offline'` for an offline token, `'Refresh'` otherwise. */
export function refreshTokenType(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
    typ?: string;
  };
  return payload.typ ?? '';
}

/**
 * Ask KEYCLOAK whether this refresh token still works, by using it.
 *
 * THIS IS THE ONLY EVIDENCE THAT COUNTS for SC-012. Observing a local `$unset` shows that the
 * BFF forgot the token, which is a different claim entirely — a silently retained offline token
 * is precisely the failure the spec singles out, and a local delete is what it would look like.
 */
export async function offlineTokenStillWorks(
  refreshToken: string,
  // The client the token was issued to. Keycloak refuses a refresh presented by any other client,
  // so checking a dedicated-client grant (feature 083) as the login client would read "revoked"
  // whether or not it was.
  client: { id: string; secret: string } = { id: CLIENT_ID, secret: CLIENT_SECRET },
): Promise<boolean> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.id,
      client_secret: client.secret,
      refresh_token: refreshToken,
    }).toString(),
  });
  return res.ok;
}
