/**
 * T031 — US3 "admin disables self-registration" integration tests
 * (real BFF + real Keycloak Admin API + real Mongo; no mocking — constitution Test Type Integrity).
 *
 * Drives the live BFF over HTTP with real ROPC bearer tokens and asserts the full contract:
 *   - an mc-admin PATCH /bff-api/admin/settings PERSISTS to the real Mongo `app_settings`
 *     single global doc (asserted directly against the collection, incl. updatedBy = admin UUID);
 *   - a non-admin (mc-user) is refused 403 on GET and PATCH, and the setting is unchanged;
 *   - with self-registration DISABLED, POST /bff-api/auth/register is refused 403 AND no Keycloak
 *     user is created (asserted ABSENT via the real Admin API); re-enabling restores registration
 *     (the same payload then creates a user — cleaned up in afterAll).
 *
 * The `app_settings` collection is a SINGLE global doc shared with the running BFF and every other
 * integration suite, so beforeAll snapshots it and afterAll restores it — leaving registration
 * ENABLED (its default) so later suites (auth-register, register-rate-limit) are unaffected.
 * Test users use unique namespaced usernames and are deleted in afterAll (no orphans).
 *
 * Run: pnpm nx test:integration mcm-app -- --testPathPattern "admin-registration"
 */
import { randomUUID } from 'node:crypto';
import {
  createTestUser,
  deleteTestUser,
  getTestTokens,
  assignRole,
  ensureRopcAudienceMapper,
  findUsersByUsername,
  type TestUser,
} from './helpers/keycloak-test-client';
import { createBffClient } from './helpers/bff-test-server';
import { getAppSettingsCollection, closeMongo } from '@/bff-server/mongo-client';
import { APP_SETTINGS_GLOBAL_ID, type AppSettingsDoc } from '@/types/app-settings';

const bff = createBffClient();

// isValidUsername: 3–20 alphanumeric/underscore (no hyphens).
const uniqueSuffix = () => randomUUID().replace(/-/g, '').slice(0, 10);
const STRONG_PASSWORD = 'IntegrationP@ss123!';

async function readSettingsDoc(): Promise<AppSettingsDoc | null> {
  const col = await getAppSettingsCollection();
  return col.findOne({ _id: APP_SETTINGS_GLOBAL_ID });
}

async function setRegistration(token: string, allowSelfRegistration: boolean) {
  return bff.patch(
    '/bff-api/admin/settings',
    { allowSelfRegistration },
    { headers: { Authorization: `Bearer ${token}` } },
  );
}

describe('US3 admin disables self-registration — integration (real BFF + Keycloak + Mongo)', () => {
  let admin: TestUser;
  let adminToken: string;
  let plain: TestUser;
  let plainToken: string;
  let initialDoc: AppSettingsDoc | null;
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await ensureRopcAudienceMapper();

    admin = await createTestUser('us3-admin');
    await assignRole(admin.userId, 'mc-admin');
    ({ accessToken: adminToken } = await getTestTokens(admin.username, admin.password));

    plain = await createTestUser('us3-user');
    await assignRole(plain.userId, 'mc-user');
    ({ accessToken: plainToken } = await getTestTokens(plain.username, plain.password));

    // Snapshot the shared global settings doc so afterAll can restore it exactly.
    initialDoc = await readSettingsDoc();
  });

  afterAll(async () => {
    // Restore the global settings doc to its pre-test state so later suites see the default
    // (registration ENABLED). replaceOne(upsert) rather than a toggle-back so a mid-test failure
    // still leaves a clean state.
    const col = await getAppSettingsCollection();
    if (initialDoc) {
      await col.replaceOne({ _id: APP_SETTINGS_GLOBAL_ID }, initialDoc, { upsert: true });
    } else {
      await col.deleteOne({ _id: APP_SETTINGS_GLOBAL_ID });
    }
    await closeMongo();
    await deleteTestUser(admin?.userId);
    await deleteTestUser(plain?.userId);
    for (const id of createdUserIds) await deleteTestUser(id);
  });

  it('mc-admin PATCH persists the toggle to the real Mongo doc (updatedBy = admin UUID)', async () => {
    const off = await setRegistration(adminToken, false);
    expect(off.status).toBe(200);
    expect(off.data.allowSelfRegistration).toBe(false);

    const doc = await readSettingsDoc();
    expect(doc?.allowSelfRegistration).toBe(false);
    expect(doc?.updatedBy).toBe(admin.userId); // Keycloak UUID, never username/email
    expect(doc?.updatedAt).toBeTruthy();

    // Toggle back on and confirm the persisted flip.
    const on = await setRegistration(adminToken, true);
    expect(on.status).toBe(200);
    expect((await readSettingsDoc())?.allowSelfRegistration).toBe(true);
  });

  it('non-admin (mc-user) is refused 403 on GET and PATCH; the setting is unchanged', async () => {
    const before = await readSettingsDoc();

    const get = await bff.get('/bff-api/admin/settings', {
      headers: { Authorization: `Bearer ${plainToken}` },
    });
    expect(get.status).toBe(403);

    const patch = await setRegistration(plainToken, false);
    expect(patch.status).toBe(403);

    const after = await readSettingsDoc();
    expect(after?.allowSelfRegistration).toBe(before?.allowSelfRegistration);
  });

  it('register refused 403 when disabled AND no Keycloak user is created; re-enabling restores it', async () => {
    expect((await setRegistration(adminToken, false)).status).toBe(200);

    const username = `intreg_${uniqueSuffix()}`;
    const body = {
      username,
      email: `${username}@test.invalid`,
      firstName: 'Int',
      lastName: 'Reg',
      password: STRONG_PASSWORD,
    };

    const refused = await bff.post('/bff-api/auth/register', body);
    expect(refused.status).toBe(403);
    expect(refused.data.code).toBe('FORBIDDEN');

    // The gate runs BEFORE any Keycloak user creation — assert the user is ABSENT.
    expect(await findUsersByUsername(username)).toHaveLength(0);

    // Re-enable → the same payload now succeeds (proves the gate flips both ways).
    expect((await setRegistration(adminToken, true)).status).toBe(200);
    const allowed = await bff.post('/bff-api/auth/register', body);
    expect(allowed.status).toBe(201);
    expect(allowed.data.userId).toBeTruthy();
    createdUserIds.push(allowed.data.userId);

    expect(await findUsersByUsername(username)).toHaveLength(1);
  });
});
