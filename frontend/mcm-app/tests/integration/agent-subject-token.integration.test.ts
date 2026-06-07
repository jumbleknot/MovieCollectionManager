/**
 * Agent subject-token mint — real Keycloak integration (T023), feature 012.
 *
 * Verifies the BFF's RFC 8693 first exchange against a LIVE Keycloak (constitution
 * v1.3.0 — no mocking the dependency under integration). Acquires a real user token via
 * the `mcm-bff-test` ROPC client, exchanges it through `agent-subject-token`, and asserts
 * the minted token is run-scoped: narrowed to `aud=agent-gateway`, carries the
 * `agent_origin=true` marker (research R3), and has a TTL within the ≤180 s ceiling.
 *
 * Requires Keycloak standard token exchange configured (T012 script applied) and the
 * subject-token client creds present in `.env.local`
 * (AGENT_SUBJECT_TOKEN_CLIENT_ID/_SECRET/_AUDIENCE). Skips cleanly when unconfigured —
 * the secret is gitignored and never cassetted (constitution §Test Type Integrity).
 */
import {
  mintSubjectToken,
  isSubjectTokenExchangeConfigured,
  SUBJECT_TOKEN_MAX_TTL_SECONDS,
} from '@/bff-server/agent-subject-token';
import { AuthError } from '@/types/errors';
import {
  ensureRopcAudienceMapper,
  ensureRopcAudienceFor,
  ensureClientAudienceMapper,
  createTestUser,
  deleteTestUser,
  getTestTokens,
  assignRole,
  type TestUser,
} from './helpers/keycloak-test-client';

/** Decode a JWT payload (no signature check — asserting claims only). */
function decodePayload(jwt: string): Record<string, unknown> {
  const part = jwt.split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf-8')) as Record<string, unknown>;
}

const configured = isSubjectTokenExchangeConfigured();
const describeOrSkip = configured ? describe : describe.skip;

if (!configured) {
  // eslint-disable-next-line no-console
  console.warn(
    'SKIP agent-subject-token integration: set AGENT_SUBJECT_TOKEN_CLIENT_ID/_SECRET/_AUDIENCE ' +
      'in frontend/mcm-app/.env.local (T012 applied) to run against real Keycloak.',
  );
}

describeOrSkip('mintSubjectToken vs real Keycloak', () => {
  let user: TestUser;
  let userAccessToken: string;

  const subjectClientId = process.env.AGENT_SUBJECT_TOKEN_CLIENT_ID ?? 'agent-subject-token';
  const gatewayAud = process.env.AGENT_SUBJECT_TOKEN_AUDIENCE ?? 'agent-gateway';

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    // (1) Standard token exchange requires the REQUESTER to be within the subject token's
    // audience — put `agent-subject-token` in the ROPC token's `aud` (test client only;
    // production satisfies this on the app client — see configure-token-exchange.mjs note).
    await ensureRopcAudienceFor(subjectClientId);
    // (2) Make `agent-gateway` an AVAILABLE downscope target for the requester, so
    // `audience=agent-gateway` is honored (else `invalid_request: audience not available`).
    // Production equivalent is applied by the T012 script onto the same client.
    await ensureClientAudienceMapper(subjectClientId, gatewayAud);
    user = await createTestUser('agent-subject-tok');
    await assignRole(user.userId, 'mc-user');
    ({ accessToken: userAccessToken } = await getTestTokens(user.username, user.password));
  }, 30_000);

  afterAll(async () => {
    await deleteTestUser(user?.userId);
  });

  it('mints a run-scoped token narrowed to the gateway audience with the agent-origin marker', async () => {
    const { token, expiresIn } = await mintSubjectToken(userAccessToken);

    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // a JWS

    const claims = decodePayload(token);

    // Audience narrowed to the gateway (string or array form).
    const aud = claims.aud;
    const audList = Array.isArray(aud) ? aud : [aud];
    expect(audList).toContain('agent-gateway');

    // Agent-origin marker (research R3) — distinct signal for mc-service/OPA (T024).
    expect(claims.agent_origin).toBe(true);

    // Run-scoped TTL: Keycloak lifespan and our defensive cap both bound it to ≤180 s.
    expect(expiresIn).toBeGreaterThan(0);
    expect(expiresIn).toBeLessThanOrEqual(SUBJECT_TOKEN_MAX_TTL_SECONDS);
    const tokenTtl = Number(claims.exp) - Number(claims.iat);
    expect(tokenTtl).toBeLessThanOrEqual(SUBJECT_TOKEN_MAX_TTL_SECONDS);
  }, 20_000);

  it('rejects a malformed subject token with a typed AuthError', async () => {
    await expect(mintSubjectToken('not-a-valid-token')).rejects.toBeInstanceOf(AuthError);
  }, 20_000);
});
