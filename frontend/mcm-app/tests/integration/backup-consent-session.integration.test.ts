/**
 * Revoking backup consent must not end the member's sign-in session (feature 083, #702).
 *
 * THE DEFECT THIS PINS. The consent round trip runs in a browser that already holds the member's
 * SSO cookie, so Keycloak attaches the offline grant to the member's EXISTING session. When the
 * grant was issued to the login client, revoking it — by any API — took the login client's session
 * with it: the member's access token still validated locally at the BFF, but Keycloak refused to
 * exchange it (`invalid_token`, so the assistant answered "No caller identity") and refused to
 * refresh it (`Session not active`, so the member was signed out). Measured on Keycloak 26.8.0;
 * the five variants tried are in specs/083-backup-consent-session-isolation/spec.md.
 *
 * WHY A BROWSER-SHAPED FLOW AND NOT `acquireOfflineRefreshToken`. That helper logs in from a fresh
 * cookie jar, which creates a SEPARATE session — and in a separate session the revoke is harmless,
 * so a test built on it passes against the defect. The consent here follows the BFF's own
 * authorization URL inside the jar the member signed in with.
 */
import * as offlineToken from '@/bff-server/backup-offline-token';
import { mintSubjectToken, isSubjectTokenExchangeConfigured } from '@/bff-server/agent-subject-token';
import { closeMongo, getAgentConfigCollection } from '@/bff-server/mongo-client';
import { createTestUser, deleteTestUser, type TestUser } from './helpers/keycloak-test-client';
import {
  browserLogin,
  followAuthorize,
  offlineTokenStillWorks,
  type BrowserSession,
} from './helpers/offline-token-flow';

const CREDS_PRESENT = Boolean(
  process.env.KEYCLOAK_CLIENT_SECRET && process.env.E2E_TEST_PASSWORD && isSubjectTokenExchangeConfigured(),
);
if (!CREDS_PRESENT && process.env.MCM_REQUIRE_LIVE_STACK === '1') {
  throw new Error(
    'backup-consent-session requires KEYCLOAK_CLIENT_SECRET, E2E_TEST_PASSWORD and the agent subject-token client',
  );
}
const describeLive = CREDS_PRESENT ? describe : describe.skip;

jest.setTimeout(60_000);

// Registered on the consent client in every committed realm, and by /bff-api/auth/init.
const CONSENT_REDIRECT_URI = 'http://localhost:8082/bff-api/backups/consent';

function claims(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()) as Record<string, unknown>;
}

/** The credentials of whichever client a refresh token was issued to — its `azp`. */
function issuingClient(refreshToken: string): { id: string; secret: string } {
  const id = String(claims(refreshToken).azp);
  const loginId = process.env.KEYCLOAK_CLIENT_ID ?? 'movie-collection-manager';
  const loginSecret = process.env.KEYCLOAK_CLIENT_SECRET ?? '';
  return { id, secret: id === loginId ? loginSecret : process.env.BACKUP_CONSENT_CLIENT_SECRET || loginSecret };
}

describeLive('revoking backup consent leaves the sign-in session alive (#702)', () => {
  let user: TestUser;
  let session: BrowserSession;
  let grant = '';

  beforeAll(async () => {
    // A FRESH user: Admin-API users inherit `offline_access` through default-roles.
    user = await createTestUser('t083-consent');
    session = await browserLogin(user.username, user.password);

    // Before anything else: the session works. Without this, the "after" assertions could pass
    // against a token that never exchanged in the first place.
    await expect(mintSubjectToken(session.accessToken)).resolves.toBeDefined();

    // The consent round trip exactly as the BFF drives it, inside the member's own browser jar.
    const consent = await offlineToken.buildConsentRequest(CONSENT_REDIRECT_URI);
    const code = await followAuthorize(session.jar, consent.authorizationUrl);
    await offlineToken.completeConsent(user.userId, code, consent.codeVerifier, CONSENT_REDIRECT_URI);
  });

  afterAll(async () => {
    await (await getAgentConfigCollection()).deleteMany({ _id: user?.userId });
    await deleteTestUser(user?.userId);
    await closeMongo();
  });

  it('mints an access token that acts as the member and that mc-service accepts', async () => {
    const accessToken = await offlineToken.mintUserAccessToken(user.userId);
    const c = claims(accessToken);
    expect(c.sub).toBe(user.userId);
    // mc-service's expected audience is the login client id, whichever client minted the token.
    expect([c.aud].flat()).toContain(process.env.KEYCLOAK_CLIENT_ID ?? 'movie-collection-manager');
  });

  describe('after the grant is revoked', () => {
    beforeAll(async () => {
      await offlineToken.revokeOfflineToken(user.userId, {
        revokeAtIdp: async (token) => {
          grant = token; // captured so Keycloak can be asked about it afterwards
          await offlineToken.revokeOfflineTokenAtIdp(token);
        },
      });
    });

    it('the grant itself is refused by Keycloak (073 SC-012 still holds)', async () => {
      expect(grant).not.toBe('');
      expect(await offlineTokenStillWorks(grant, issuingClient(grant))).toBe(false);
    });

    it("the member's session token still exchanges for an agent subject token", async () => {
      await expect(mintSubjectToken(session.accessToken)).resolves.toBeDefined();
    });

    it("the member's session still refreshes", async () => {
      expect(await offlineTokenStillWorks(session.refreshToken)).toBe(true);
    });
  });
});
