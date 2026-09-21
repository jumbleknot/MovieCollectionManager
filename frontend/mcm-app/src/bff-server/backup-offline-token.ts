// Standing permission to act for a user while they are away (feature 073, T053 —
// FR-021..FR-024; SC-012).
//
// WHAT THIS HOLDS AND WHY IT IS DIFFERENT. Every other credential in this system is either the
// user's own third-party secret or an ephemeral session token. This is neither: it is an
// IdP-issued OFFLINE refresh token, long-lived by construction, which lets this server read the
// user's data with the user's own identity at 03:00 when they are asleep and holding no session.
// That is the only way FR-021 can be satisfied without inventing a broader-privileged path, and
// FR-024 bans inventing one.
//
// THE COMPENSATING CONTROLS, none of which is optional:
//   - Sealed with AES-256-GCM under AAD `${userId}:offlineRefresh`, so one user's blob cannot be
//     replayed as another's.
//   - NEVER returned to a client and never logged. `describeConsent` exists so a route can say
//     "yes, granted, on this date" without the value going anywhere near a response body.
//   - Revoked AT KEYCLOAK — not merely forgotten — on disable, delete and account deletion.
//   - No fallback. If the grant is gone the run FAILS; it does not reach for another identity.
//
// ORDER IS LOAD-BEARING: revoke at the IdP, THEN forget locally. Reversed, a failed revocation
// orphans a live offline token with no local record that it exists, so nothing can ever revoke
// it again. That is the same failure SC-012 exists to prevent, arriving by a different door.

import { randomBytes, createHash } from 'node:crypto';

import {
  backupEncryptionKey,
  decryptSecret,
  encryptSecret,
  offlineTokenAad,
} from '@/bff-server/agent-config-crypto';
import {
  getAgentConfigCollection,
  getBackupDestinationsCollection,
  getBackupJobsCollection,
  getBackupRunsCollection,
} from '@/bff-server/mongo-client';
import { logger } from '@/bff-server/logger';
import { env } from '@/config/env';

/** The grant is missing, expired or revoked. Its message is USER-FACING and names the remedy. */
export class OfflineTokenUnusableError extends Error {
  constructor(
    message = 'The permission to back up while you are away is no longer valid. Re-enable the schedule to grant it again.',
  ) {
    super(message);
    this.name = 'OfflineTokenUnusableError';
  }
}

/** Revocation at the IdP did not succeed. Surfaced, never swallowed — see the header note. */
export class OfflineTokenRevocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineTokenRevocationError';
  }
}

// TWO DIFFERENT KEYCLOAK ORIGINS, AND THE DISTINCTION IS NOT COSMETIC.
//
// `keycloakUrl` is the INTERNAL address this server dials — `keycloak-service:8080` inside the
// compose network. `keycloakPublicUrl` is the BROWSER-facing one — `localhost:8099`.
//
// The token and revoke endpoints are called by THIS PROCESS, so they take the internal URL.
// The authorize endpoint is never called from here at all: its URL is handed to the user's
// BROWSER to navigate to. Building it from the internal URL sends the browser to a hostname
// that exists only inside the Docker network, so it fails DNS and lands on a blank page —
// silently, with no error anywhere, and the schedule simply never turns on.
//
// Measured exactly that way by the T061 E2E against the dev container: the browser was sent to
// `http://keycloak-service:8080/realms/…/auth`. It did not show up in the integration tier
// because there `KEYCLOAK_URL` is already `localhost:8099`, so the two origins coincide and the
// bug is invisible. Same family as openwiki/gotchas/docker-internal-dns.md, in the other
// direction.
const tokenEndpoint = () =>
  `${env.keycloakUrl}/realms/${env.keycloakRealm}/protocol/openid-connect/token`;
const revokeEndpoint = () =>
  `${env.keycloakUrl}/realms/${env.keycloakRealm}/protocol/openid-connect/revoke`;
const browserAuthorizeEndpoint = () =>
  `${env.keycloakPublicUrl}/realms/${env.keycloakRealm}/protocol/openid-connect/auth`;

function clientCredentials(): Record<string, string> {
  return env.keycloakClientSecret
    ? { client_id: env.keycloakClientId, client_secret: env.keycloakClientSecret }
    : { client_id: env.keycloakClientId };
}

// ─── Consent (FR-022) ─────────────────────────────────────────────────────────

export interface ConsentRequest {
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
}

/**
 * Build the separate OIDC round trip that asks for standing permission.
 *
 * SEPARATE from login on purpose. The session the user already holds was established WITHOUT
 * `offline_access`, so there is no refresh token in it to promote even if the constitution
 * allowed the BFF to keep one — which it does not (v2.0.0: the session record is tokenless).
 * The user must make this grant deliberately, which is also what makes it informed consent
 * rather than something that happened to them while they were doing something else.
 *
 * The caller keeps `state` and `codeVerifier` server-side and matches them on the callback; the
 * verifier is the secret half of PKCE and never appears in the URL.
 */
export async function buildConsentRequest(redirectUri: string): Promise<ConsentRequest> {
  const codeVerifier = randomBytes(40).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  const params = new URLSearchParams({
    client_id: env.keycloakClientId,
    response_type: 'code',
    // Without this the exchange yields an ORDINARY refresh token, which dies with the SSO
    // session: the schedule would work until the user next logged out and then stop for ever,
    // silently, which is the worst way for a backup to fail.
    scope: 'openid offline_access',
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return { authorizationUrl: `${browserAuthorizeEndpoint()}?${params}`, state, codeVerifier };
}

/**
 * Exchange the consent callback's code for the offline token and store it.
 *
 * The access and id tokens that come back are DISCARDED. This round trip establishes a standing
 * permission; it does not establish a session, and turning it into one here would quietly make
 * a consent click into a login.
 */
export async function completeConsent(
  userId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<void> {
  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      ...clientCredentials(),
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!res.ok) {
    // The upstream body can echo the code and the client secret, so none of it is forwarded.
    throw new OfflineTokenUnusableError(
      'That consent could not be completed. Re-enable the schedule to try again.',
    );
  }
  const { refresh_token: refreshToken } = (await res.json()) as { refresh_token?: string };
  if (!refreshToken) throw new OfflineTokenUnusableError();
  await storeOfflineToken(userId, refreshToken);
}

// ─── Custody ──────────────────────────────────────────────────────────────────

export async function storeOfflineToken(userId: string, refreshToken: string): Promise<void> {
  const offlineRefreshEnc = encryptSecret(
    refreshToken,
    backupEncryptionKey(),
    offlineTokenAad(userId),
  );
  await (await getAgentConfigCollection()).updateOne(
    { _id: userId },
    {
      $set: {
        offlineRefreshEnc,
        offlineGrantedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      $setOnInsert: { _id: userId },
    },
    { upsert: true },
  );
  // Counts and ids only. The `audit()` sink strips keys containing `token`, but nothing about
  // that rule would have caught a field called `offlineRefreshEnc`, so none is passed.
  logger.audit('backup_schedule_consent_granted', { userId });
}

async function readOfflineToken(userId: string): Promise<string | null> {
  const doc = await (await getAgentConfigCollection()).findOne({ _id: userId });
  if (!doc?.offlineRefreshEnc) return null;
  try {
    return decryptSecret(doc.offlineRefreshEnc, backupEncryptionKey(), offlineTokenAad(userId));
  } catch {
    // A blob that will not open under this user's AAD is not usable and never will be. Treated
    // as absent rather than as an internal error, so the user gets the actionable
    // "re-enable the schedule" path instead of a 500 they can do nothing with.
    return null;
  }
}

export async function hasOfflineToken(userId: string): Promise<boolean> {
  return (await readOfflineToken(userId)) !== null;
}

/** What a route may safely tell the client: that a grant exists, and when it was made. */
export async function describeConsent(
  userId: string,
): Promise<{ granted: boolean; grantedAt: string | null }> {
  const doc = await (await getAgentConfigCollection()).findOne({ _id: userId });
  return {
    granted: Boolean(doc?.offlineRefreshEnc),
    grantedAt: doc?.offlineGrantedAt ?? null,
  };
}

// ─── Using the grant (FR-021, FR-024) ─────────────────────────────────────────

/**
 * An access token for this user, minted from their standing permission.
 *
 * THERE IS NO FALLBACK HERE, deliberately (FR-024). Every failure path throws
 * `OfflineTokenUnusableError`; none of them reaches for a service account, an admin token or
 * any other identity that could read the data anyway. A backup that silently succeeded by
 * acting with broader privilege than the user granted would be worse than one that failed.
 */
export async function mintUserAccessToken(userId: string): Promise<string> {
  const refreshToken = await readOfflineToken(userId);
  if (!refreshToken) throw new OfflineTokenUnusableError();

  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      ...clientCredentials(),
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) throw new OfflineTokenUnusableError();

  const { access_token: accessToken } = (await res.json()) as { access_token?: string };
  if (!accessToken) throw new OfflineTokenUnusableError();
  return accessToken;
}

// ─── Revocation (FR-023, SC-012) ──────────────────────────────────────────────

/**
 * Revoke at Keycloak, and REPORT whether it worked.
 *
 * Deliberately not `keycloak.ts`'s `revokeToken`, which swallows every failure because logout
 * has a natural backstop: the token expires shortly anyway. An OFFLINE token has no such
 * backstop — it does not expire — so "revocation failed" has to be a fact the caller can see.
 */
export async function revokeOfflineTokenAtIdp(refreshToken: string): Promise<void> {
  const res = await fetch(revokeEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...clientCredentials(),
      token: refreshToken,
      token_type_hint: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    throw new OfflineTokenRevocationError(
      `Keycloak refused the revocation (HTTP ${res.status}). The permission is still in force.`,
    );
  }
}

export interface RevokeOptions {
  /** Injection seam for the IdP call, so the failure path is testable without a mock server. */
  revokeAtIdp?: (refreshToken: string) => Promise<void>;
}

/**
 * Revoke the standing permission, then forget it. In that order — see the header note.
 *
 * A revocation failure THROWS and leaves the token stored, precisely so a later attempt can
 * still find it. Deleting it here would report success while a live, non-expiring token stayed
 * out there with nothing left pointing at it.
 */
export async function revokeOfflineToken(userId: string, options: RevokeOptions = {}): Promise<void> {
  const refreshToken = await readOfflineToken(userId);
  if (!refreshToken) return; // Nothing granted, nothing to revoke — a no-op, not an error.

  try {
    await (options.revokeAtIdp ?? revokeOfflineTokenAtIdp)(refreshToken);
  } catch (err) {
    // ONE typed failure whatever went wrong — Keycloak refusing, DNS failing, the connection
    // dropping. The caller's decision is the same in every case (do not delete the record, tell
    // the user), so making them discriminate between causes would only invite one to be missed.
    if (err instanceof OfflineTokenRevocationError) throw err;
    throw new OfflineTokenRevocationError(
      `The permission could not be revoked at the identity provider: ${
        err instanceof Error ? err.message : 'unknown error'
      }. It is still in force.`,
    );
  }

  await (await getAgentConfigCollection()).updateOne(
    { _id: userId },
    {
      $unset: { offlineRefreshEnc: '', offlineGrantedAt: '' },
      $set: { updatedAt: new Date().toISOString() },
    },
  );
  logger.audit('backup_schedule_consent_revoked', { userId });
}

/**
 * Give the permission up once nothing needs it any more (FR-023).
 *
 * "Nothing needs it" is ANY enabled job carrying a schedule — not the job that happened to be
 * touched. Revoking on the first disable would silently break every other schedule the user
 * still has, and the symptom would appear days later on an unrelated job.
 */
export async function revokeIfNoScheduleRemains(
  userId: string,
  options: RevokeOptions = {},
): Promise<boolean> {
  const jobs = await getBackupJobsCollection();
  const remaining = await jobs.countDocuments({
    userId,
    enabled: true,
    schedule: { $exists: true },
  });
  if (remaining > 0) return false;
  await revokeOfflineToken(userId, options);
  return true;
}

// ─── Account deletion (FR-023, spec.md Edge Cases) ────────────────────────────

/**
 * Erase everything this feature holds for a user, and give up the standing permission.
 *
 * WHAT IS DELETED: the standing permission (at Keycloak first, then locally), every
 * destination and its sealed credential, every job, and the whole run history.
 *
 * WHAT IS NOT DELETED, DELIBERATELY: the artifacts at the user's own destination. They sit in
 * storage the user owns and pays for. Removing them would not be cleaning up after ourselves —
 * it would be destroying the data we were trusted to copy, at the moment the user has least
 * reason to expect it and least ability to object. If they want those objects gone they have
 * the credentials to do it; we never had the standing to decide for them.
 *
 * ORDER: revoke, then delete. A revocation failure THROWS and leaves every local record in
 * place, so the deletion can be retried and the token is still reachable. Deleting first and
 * failing to revoke strands a live, non-expiring token at Keycloak with nothing left in this
 * system that knows it exists — the failure this whole module is arranged to prevent.
 */
export async function tearDownUserBackups(
  userId: string,
  options: RevokeOptions = {},
): Promise<void> {
  // Throws on failure, by design. Nothing below runs if this does not succeed.
  await revokeOfflineToken(userId, options);

  // Three independent deletes because there is no transaction on a standalone Mongo. They are
  // ordered destinations → jobs → runs so that a crash part way through never leaves a job
  // pointing at a destination that is gone, which is the state that would be hardest to
  // interpret if someone had to finish the job by hand.
  await (await getBackupDestinationsCollection()).deleteMany({ userId });
  await (await getBackupJobsCollection()).deleteMany({ userId });
  await (await getBackupRunsCollection()).deleteMany({ userId });

  logger.audit('backup_account_teardown_completed', { userId });
}
