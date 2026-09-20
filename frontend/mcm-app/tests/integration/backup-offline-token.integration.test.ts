/**
 * Offline-token custody: consent, mint, revoke (feature 073, T052 — FR-021..FR-024; SC-012;
 * US4-AC2, US4-AC3, US4-AC7).
 *
 * THE ASSERTION THAT MATTERS IS MADE AT KEYCLOAK. After the last schedule is disabled, this
 * suite takes the refresh token the BFF was holding and USES it against Keycloak, and requires
 * Keycloak to reject it. Observing the local `$unset` would show only that the BFF forgot the
 * token — and a silently retained offline token, still live at the IdP with nothing locally
 * pointing at it, is exactly the failure SC-012 names. A local delete is what that failure
 * looks like from inside the BFF.
 *
 * REAL KEYCLOAK, REAL TOKENS, A REAL AUTHORIZATION-CODE ROUND TRIP. No part of this can be
 * mocked and still mean anything: the claim under test is about what a third party will accept.
 */
import {
  createTestUser,
  deleteTestUser,
  type TestUser,
} from './helpers/keycloak-test-client';
import {
  acquireOfflineRefreshToken,
  offlineTokenStillWorks,
  refreshTokenType,
} from './helpers/offline-token-flow';

import * as offlineToken from '@/bff-server/backup-offline-token';
import * as destinationStore from '@/bff-server/backup-destination-store';
import * as jobStore from '@/bff-server/backup-job-store';
import * as snapshotReader from '@/bff-server/backup-snapshot-reader';
import { runScheduledBackup } from '@/bff-server/backup-runner';
import { decryptSecret, offlineTokenAad, backupEncryptionKey } from '@/bff-server/agent-config-crypto';
import { getAgentConfigCollection } from '@/bff-server/mongo-client';
import {
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  getBackupRunsCollection,
  closeMongo,
} from '@/bff-server/mongo-client';
import { randomUUID } from 'node:crypto';

// Feature 041's skip-escalation convention: a skipped test reads as a pass, so when the CI
// contract says the live stack must be there, an absent credential FAILS instead of skipping.
const CREDS_PRESENT = Boolean(process.env.KEYCLOAK_CLIENT_SECRET && process.env.E2E_TEST_PASSWORD);
if (!CREDS_PRESENT && process.env.MCM_REQUIRE_LIVE_STACK === '1') {
  throw new Error('backup-offline-token requires KEYCLOAK_CLIENT_SECRET and E2E_TEST_PASSWORD');
}
const describeLive = CREDS_PRESENT ? describe : describe.skip;

jest.setTimeout(60_000);

describeLive('offline token custody', () => {
  let user: TestUser;
  let destinationId: string;

  beforeAll(async () => {
    // A FRESH user, not the shared E2E account. A user created through the Admin API inherits
    // the realm's default-roles composite, which carries `offline_access`; the seeded
    // `e2e-test-user` was imported with no realm roles at all and cannot be granted an offline
    // token as things stand. Creating our own also keeps this suite off shared state entirely.
    user = await createTestUser('t052-offline');
    destinationId = (
      await destinationStore.createDestination(user.userId, {
        type: 's3',
        label: `offline-${randomUUID()}`,
        endpoint: 'https://s3.example.com',
        bucket: 'backups',
        region: 'us-east-1',
        pathStyle: true,
        accessKeyId: 'AKIDEXAMPLE',
        secret: 'the-secret',
      })
    ).id;
  });

  afterAll(async () => {
    await (await getBackupDestinationsCollection()).deleteMany({ userId: user?.userId });
    await (await getBackupJobsCollection()).deleteMany({ userId: user?.userId });
    await (await getBackupRunsCollection()).deleteMany({ userId: user?.userId });
    await (await getAgentConfigCollection()).deleteMany({ _id: user?.userId });
    await deleteTestUser(user?.userId);
    await closeMongo();
  });

  const scheduledJob = async (enabled = true) =>
    jobStore.createJob(user.userId, {
      destinationId,
      label: `job-${randomUUID().slice(0, 8)}`,
      collectionIds: [],
      keepLast: 7,
      enabled,
      schedule: { frequency: 'daily', hour: 3, minute: 0, timeZone: 'UTC' },
    });

  describe('consent stores a real offline token, sealed', () => {
    it('stores the token as an AAD-bound blob that is never held in the clear', async () => {
      const token = await acquireOfflineRefreshToken(user.username, user.password);
      expect(refreshTokenType(token)).toBe('Offline');

      await offlineToken.storeOfflineToken(user.userId, token);

      const doc = await (await getAgentConfigCollection()).findOne({ _id: user.userId });
      // The ciphertext is on the document; the plaintext is nowhere on it.
      expect(doc?.offlineRefreshEnc).toBeTruthy();
      expect(JSON.stringify(doc)).not.toContain(token);
      // And it really is this user's: decrypting under another user's AAD must fail, not
      // quietly return something. Two users' blobs must not be interchangeable.
      expect(() =>
        decryptSecret(doc!.offlineRefreshEnc!, backupEncryptionKey(), offlineTokenAad('someone-else')),
      ).toThrow();
      expect(
        decryptSecret(doc!.offlineRefreshEnc!, backupEncryptionKey(), offlineTokenAad(user.userId)),
      ).toBe(token);
    });

    it('records that consent was given, and reports the grant without revealing it', async () => {
      const token = await acquireOfflineRefreshToken(user.username, user.password);
      await offlineToken.storeOfflineToken(user.userId, token);

      expect(await offlineToken.hasOfflineToken(user.userId)).toBe(true);
      const status = await offlineToken.describeConsent(user.userId);
      expect(status.granted).toBe(true);
      expect(status.grantedAt).toEqual(expect.any(String));
      // The status object is what a route may return. It must not carry the token in any form.
      expect(JSON.stringify(status)).not.toContain(token);
    });

    it('builds an authorization URL that asks for offline access, with PKCE', async () => {
      // FR-022: enabling a schedule is a SEPARATE OIDC round trip whose result is stored, never
      // turned into a session. Without `offline_access` in the scope the exchange yields an
      // ordinary refresh token, which dies with the user's SSO session — the schedule would then
      // work until the user logged out and silently stop for ever after.
      const { authorizationUrl, state, codeVerifier } = await offlineToken.buildConsentRequest(
        'http://localhost:8081/bff-api/backups/consent',
      );
      const url = new URL(authorizationUrl);
      expect(url.searchParams.get('scope')?.split(' ')).toContain('offline_access');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBeTruthy();
      expect(state).toBeTruthy();
      expect(codeVerifier).toBeTruthy();
      // The verifier is the secret half of PKCE and must never travel in the URL.
      expect(authorizationUrl).not.toContain(codeVerifier);
    });
  });

  describe('an unattended run reads as the user', () => {
    it('mints a usable access token from the stored grant, with no session anywhere', async () => {
      const token = await acquireOfflineRefreshToken(user.username, user.password);
      await offlineToken.storeOfflineToken(user.userId, token);

      const accessToken = await offlineToken.mintUserAccessToken(user.userId);

      expect(typeof accessToken).toBe('string');
      const claims = JSON.parse(
        Buffer.from(accessToken.split('.')[1], 'base64url').toString(),
      ) as { sub: string };
      // FR-021: the run acts AS THE USER. A service identity here would mean mc-service's DAC
      // was being bypassed rather than satisfied.
      expect(claims.sub).toBe(user.userId);
    });

    it('mints repeatedly from the same stored grant', async () => {
      // An offline token is used once per scheduled run, for ever. If a single use consumed or
      // rotated it, every job would work exactly once and then fail silently.
      const token = await acquireOfflineRefreshToken(user.username, user.password);
      await offlineToken.storeOfflineToken(user.userId, token);

      await expect(offlineToken.mintUserAccessToken(user.userId)).resolves.toEqual(expect.any(String));
      await expect(offlineToken.mintUserAccessToken(user.userId)).resolves.toEqual(expect.any(String));
    });
  });

  describe('SC-012 — disabling the last schedule makes the grant unusable AT KEYCLOAK', () => {
    it('leaves the stored token rejected by Keycloak when used', async () => {
      const token = await acquireOfflineRefreshToken(user.username, user.password);
      await offlineToken.storeOfflineToken(user.userId, token);
      const job = await scheduledJob();

      // Before: the token genuinely works. Without this the "after" assertion could pass
      // against a token that was never valid in the first place.
      expect(await offlineTokenStillWorks(token)).toBe(true);

      await jobStore.updateJob(user.userId, job.id, { enabled: false });
      await offlineToken.revokeIfNoScheduleRemains(user.userId);

      // THE ASSERTION. Keycloak, asked to honour the token, refuses.
      expect(await offlineTokenStillWorks(token)).toBe(false);
      expect(await offlineToken.hasOfflineToken(user.userId)).toBe(false);
    });

    it('keeps the grant while ANOTHER enabled schedule still needs it', async () => {
      const token = await acquireOfflineRefreshToken(user.username, user.password);
      await offlineToken.storeOfflineToken(user.userId, token);
      const keep = await scheduledJob();
      const drop = await scheduledJob();

      await jobStore.updateJob(user.userId, drop.id, { enabled: false });
      await offlineToken.revokeIfNoScheduleRemains(user.userId);

      // Revoking here would silently break the job the user did NOT touch.
      expect(await offlineTokenStillWorks(token)).toBe(true);
      expect(await offlineToken.hasOfflineToken(user.userId)).toBe(true);

      await jobStore.updateJob(user.userId, keep.id, { enabled: false });
      await offlineToken.revokeIfNoScheduleRemains(user.userId);
      expect(await offlineTokenStillWorks(token)).toBe(false);
    });

    it('revokes at Keycloak BEFORE forgetting the token locally', async () => {
      // Order is load-bearing. Reversed, a failed revocation orphans a live offline token with
      // no local record that it exists — and nothing left that could ever revoke it.
      //
      // Observed through the injection seam rather than a spy: `revokeOfflineTokenAtIdp` is
      // called from inside its own module, so `jest.spyOn` on the module object would not
      // intercept it and the test would silently assert nothing.
      const token = await acquireOfflineRefreshToken(user.username, user.password);
      await offlineToken.storeOfflineToken(user.userId, token);

      let stillStoredWhenIdpWasCalled: boolean | null = null;
      await offlineToken.revokeOfflineToken(user.userId, {
        revokeAtIdp: async (t) => {
          stillStoredWhenIdpWasCalled = await offlineToken.hasOfflineToken(user.userId);
          await offlineToken.revokeOfflineTokenAtIdp(t);
        },
      });

      expect(stillStoredWhenIdpWasCalled).toBe(true);
      expect(await offlineToken.hasOfflineToken(user.userId)).toBe(false);
      expect(await offlineTokenStillWorks(token)).toBe(false);
    });

    it('surfaces a revocation failure instead of swallowing it', async () => {
      // If Keycloak cannot be reached, the honest outcome is an error the user sees — NOT a
      // local delete that reports success while a live token stays out there for ever.
      const token = await acquireOfflineRefreshToken(user.username, user.password);
      await offlineToken.storeOfflineToken(user.userId, token);

      await expect(
        offlineToken.revokeOfflineToken(user.userId, {
          revokeAtIdp: async () => {
            throw new Error('Keycloak unreachable');
          },
        }),
      ).rejects.toThrow(offlineToken.OfflineTokenRevocationError);

      // Still stored, precisely so it can be revoked on a later attempt.
      expect(await offlineToken.hasOfflineToken(user.userId)).toBe(true);
      expect(await offlineTokenStillWorks(token)).toBe(true);
    });
  });

  describe('US4-AC7 — a revoked grant fails the run, with no fallback', () => {
    afterEach(() => jest.restoreAllMocks());

    it('fails with a reason that tells the user to re-enable the schedule', async () => {
      const token = await acquireOfflineRefreshToken(user.username, user.password);
      await offlineToken.storeOfflineToken(user.userId, token);
      await offlineToken.revokeOfflineToken(user.userId);

      await expect(offlineToken.mintUserAccessToken(user.userId)).rejects.toThrow(
        offlineToken.OfflineTokenUnusableError,
      );
      // Actionable, and it names the remedy. "Unauthorized" would leave the user with a job
      // that has silently stopped and nothing to do about it.
      await expect(offlineToken.mintUserAccessToken(user.userId)).rejects.toThrow(/re-enable/i);
    });

    it('never reads the user data by any other route once the grant is gone (FR-024)', async () => {
      // OBSERVED, NOT SUBSTITUTED: `spyOn` without an implementation keeps the real function,
      // so this asserts the production path, not a stand-in. If a fallback to a service
      // identity or an admin token were ever added, the snapshot read would still happen and
      // this assertion is what would catch it.
      const readSpy = jest.spyOn(snapshotReader, 'readSnapshot');
      const token = await acquireOfflineRefreshToken(user.username, user.password);
      await offlineToken.storeOfflineToken(user.userId, token);
      await offlineToken.revokeOfflineToken(user.userId);
      const job = await scheduledJob();

      const run = await runScheduledBackup(user.userId, job.id);

      expect(run.status).toBe('failed');
      expect(run.failureReason).toMatch(/re-enable/i);
      expect(readSpy).not.toHaveBeenCalled();
    });

    it('fails the same way when no consent was ever given', async () => {
      const stranger = `t052-nobody-${randomUUID()}`;
      await expect(offlineToken.mintUserAccessToken(stranger)).rejects.toThrow(
        offlineToken.OfflineTokenUnusableError,
      );
    });
  });
});
