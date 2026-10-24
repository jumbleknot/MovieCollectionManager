/**
 * Which Keycloak client the backup consent round trip, and every later use of its grant, runs as
 * (feature 083, #702).
 *
 * The consent must NOT run on the login client: Keycloak attaches the offline grant to the
 * member's existing session, and revoking a login-client grant ends that session. These tests pin
 * the client choice; the session behaviour itself is pinned against a live Keycloak in
 * tests/integration/backup-consent-session.integration.test.ts.
 */
import { env } from '@/config/env';
import {
  buildConsentRequest,
  credentialsFor,
  OfflineTokenUnusableError,
} from '@/bff-server/backup-offline-token';

jest.mock('@/config/env', () => ({
  env: {
    keycloakPublicUrl: 'http://localhost:8099',
    keycloakUrl: 'http://keycloak-service:8080',
    keycloakRealm: 'grumpyrobot',
    keycloakClientId: 'movie-collection-manager',
    keycloakClientSecret: 'login-secret',
    backupConsentClientId: 'mcm-backup-consent',
    backupConsentClientSecret: 'consent-secret',
  },
}));

const mockEnv = env as unknown as {
  keycloakClientId: string;
  keycloakClientSecret: string;
  backupConsentClientId: string;
  backupConsentClientSecret: string;
};

/** An unsigned token with the given payload — `credentialsFor` reads claims, Keycloak verifies. */
function tokenFor(payload: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS512' })}.${part(payload)}.sig`;
}

beforeEach(() => {
  mockEnv.keycloakClientId = 'movie-collection-manager';
  mockEnv.keycloakClientSecret = 'login-secret';
  mockEnv.backupConsentClientId = 'mcm-backup-consent';
  mockEnv.backupConsentClientSecret = 'consent-secret';
});

describe('the consent request', () => {
  it('names the dedicated consent client, not the login client', async () => {
    const { authorizationUrl } = await buildConsentRequest('http://localhost:8082/bff-api/backups/consent');
    expect(new URL(authorizationUrl).searchParams.get('client_id')).toBe('mcm-backup-consent');
  });

  it('falls back to the login client when no consent client is configured', async () => {
    // US3: production before the operator creates the client behaves exactly as before.
    mockEnv.backupConsentClientId = mockEnv.keycloakClientId;
    const { authorizationUrl } = await buildConsentRequest('http://localhost:8082/bff-api/backups/consent');
    expect(new URL(authorizationUrl).searchParams.get('client_id')).toBe('movie-collection-manager');
  });
});

describe('credentialsFor — a grant is used as the client it was issued to', () => {
  it('uses the consent client for a grant the consent client issued', () => {
    expect(credentialsFor(tokenFor({ azp: 'mcm-backup-consent', typ: 'Offline' }))).toEqual({
      client_id: 'mcm-backup-consent',
      client_secret: 'consent-secret',
    });
  });

  it('uses the login client for a grant made before feature 083', () => {
    // Stored grants are not migrated: they keep working, as the client that minted them.
    expect(credentialsFor(tokenFor({ azp: 'movie-collection-manager', typ: 'Offline' }))).toEqual({
      client_id: 'movie-collection-manager',
      client_secret: 'login-secret',
    });
  });

  it('never presents the consent secret for a client it does not belong to', () => {
    // An unexpected azp gets the LOGIN identity; Keycloak refuses the mismatch and the grant fails
    // as unusable. Nothing reaches for a broader identity (073 FR-024).
    expect(credentialsFor(tokenFor({ azp: 'someone-else' }))).toEqual({
      client_id: 'movie-collection-manager',
      client_secret: 'login-secret',
    });
  });

  it('treats a token whose claims cannot be read as unusable', () => {
    expect(() => credentialsFor('not-a-jwt')).toThrow(OfflineTokenUnusableError);
  });
});
