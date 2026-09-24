/**
 * Drive Keycloak's BROWSER login flow from Node (feature 076).
 *
 * The step-up is an interactive authentication, so the only way to observe what the identity
 * provider actually demands is to walk the login pages the way a browser would. The realm gates
 * TOTP on `conditional-user-configured`, which means the second factor appears for a user who
 * has one enrolled and not for a user who does not — the behaviour FR-007 and FR-008 describe,
 * and the thing that cannot be checked by reading configuration alone.
 *
 * COOKIES ARE HANDLED BY HAND, and that is not fussiness. Node's `http.cookiejar` rewrites the
 * dotless host `localhost` to `localhost.local`, and Keycloak marks its session cookies `Secure`,
 * so a stock jar never sends them back over http. Keycloak then answers `400` with the login page
 * re-served and no error text — which reads exactly like a wrong password. Measured 2026-09-24.
 */
import { createHmac, randomBytes } from 'node:crypto';

const KEYCLOAK_URL = process.env.KEYCLOAK_URL || 'http://localhost:8099';
const REALM = process.env.KEYCLOAK_REALM || 'grumpyrobot';
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID || 'movie-collection-manager';
const ADMIN_BASE = `${KEYCLOAK_URL}/admin/realms/${REALM}`;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * RFC 6238 TOTP, matching the realm's default policy (SHA1, 6 digits, 30s).
 *
 * THE KEY IS THE SECRET'S RAW UTF-8 BYTES, not a base32 decode of them. Keycloak stores
 * `secretData.value` as a plain string and HMACs the bytes of that string; the base32 form a user
 * sees in the QR code is `base32(thoseBytes)`, a presentation of the key rather than the key
 * itself. Base32-decoding it here produces a valid-looking six-digit code that Keycloak rejects
 * every time — the OTP form is simply re-served with a 200, which reads as "wrong code" and
 * gives no hint that the key was mis-derived. Measured 2026-09-24.
 */
export function totpCode(secret: string, atSeconds = Math.floor(Date.now() / 1000)): string {
  const counter = Buffer.alloc(8);
  counter.writeBigInt64BE(BigInt(Math.floor(atSeconds / 30)));
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

async function adminToken(): Promise<string> {
  const res = await fetch(`${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.KEYCLOAK_SERVICE_CLIENT_ID || 'mcm-bff-service',
      client_secret: process.env.KEYCLOAK_SERVICE_CLIENT_SECRET || '',
    }),
  });
  if (!res.ok) throw new Error(`admin token failed (${res.status})`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/**
 * Give a user a TOTP credential, returning the base32 secret.
 *
 * `PUT /users/{id}` with the credential in the array — the `POST /users/{id}/credentials` shape
 * answers 404 on this Keycloak (measured), so the working form is not the obvious one.
 */
export async function enrolTotp(userId: string): Promise<string> {
  const secret = base32Encode(randomBytes(20));
  const res = await fetch(`${ADMIN_BASE}/users/${userId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await adminToken()}`,
    },
    body: JSON.stringify({
      credentials: [
        {
          type: 'otp',
          userLabel: 'integration-test',
          secretData: JSON.stringify({ value: secret }),
          credentialData: JSON.stringify({
            subType: 'totp',
            digits: 6,
            period: 30,
            algorithm: 'HmacSHA1',
          }),
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`TOTP enrolment failed (${res.status})`);
  return secret;
}

export interface StepUpWalkResult {
  /** Did Keycloak ask for a second factor after the password was accepted? */
  promptedForOtp: boolean;
  /** The authorization code, when the flow completed. */
  code?: string;
}

/**
 * Walk the authorize → password → (OTP) → redirect sequence with `max_age=0`.
 *
 * Returns whether an OTP page was served, which is the observation FR-007/FR-008 turn on.
 */
export async function walkStepUpLogin(opts: {
  username: string;
  password: string;
  redirectUri: string;
  totpSecret?: string;
  state?: string;
  codeChallenge?: string;
}): Promise<StepUpWalkResult> {
  const cookies = new Map<string, string>();
  const remember = (res: Response): void => {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const idx = pair!.indexOf('=');
      if (idx > 0) cookies.set(pair!.slice(0, idx).trim(), pair!.slice(idx + 1).trim());
    }
  };
  const cookieHeader = (): Record<string, string> =>
    cookies.size ? { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {};

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: 'openid',
    redirect_uri: opts.redirectUri,
    state: opts.state ?? randomBytes(8).toString('hex'),
    prompt: 'login',
    max_age: '0',
  });
  if (opts.codeChallenge) {
    params.set('code_challenge', opts.codeChallenge);
    params.set('code_challenge_method', 'S256');
  }

  const authRes = await fetch(
    `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/auth?${params}`,
    { redirect: 'manual' },
  );
  remember(authRes);
  let page = await authRes.text();

  /**
   * The action of the first form that posts credentials.
   *
   * NOT keyed on `id="kc-form-login"`: the OTP page uses `kc-otp-login-form`, so an id-specific
   * match silently falls back to the PASSWORD form's action and the one-time code is posted to a
   * step that has already completed — which looks like a rejected code.
   */
  const formAction = (html: string): string | null => {
    const m = html.match(/<form[^>]*\baction="([^"]+)"[^>]*>/) ?? html.match(/<form[^>]*id="[^"]*login[^"]*"[^>]*action="([^"]+)"/);
    return m ? m[1]!.replace(/&amp;/g, '&') : null;
  };

  const passwordAction = formAction(page);
  if (!passwordAction) throw new Error('no login form was served');

  let res = await fetch(passwordAction, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...cookieHeader() },
    body: new URLSearchParams({
      username: opts.username,
      password: opts.password,
      credentialId: '',
    }),
  });
  remember(res);

  let promptedForOtp = false;

  // A 200 after the password means another page was served rather than a redirect — for this
  // realm that page is the OTP form.
  if (res.status === 200) {
    page = await res.text();
    if (/name="otp"|kc-otp-login-form|One-time code/i.test(page)) {
      promptedForOtp = true;
      if (!opts.totpSecret) return { promptedForOtp };

      const otpAction = formAction(page);
      if (!otpAction) throw new Error('OTP page served but no form action found');
      res = await fetch(otpAction, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...cookieHeader() },
        body: new URLSearchParams({ otp: totpCode(opts.totpSecret) }),
      });
      remember(res);
    } else {
      throw new Error('password was not accepted and no OTP form was served');
    }
  }

  const location = res.headers.get('location') ?? '';
  const code = new URL(location, opts.redirectUri).searchParams.get('code') ?? undefined;
  return { promptedForOtp, code };
}
