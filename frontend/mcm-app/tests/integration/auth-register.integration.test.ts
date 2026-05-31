/**
 * /bff-api/auth/register integration tests (T013) — FR-014 / SC-006, US5.
 *
 * HTTP-level against the running BFF + real Keycloak Admin API — no mocking
 * (constitution v1.3.0). Verifies real user creation, the mc-user role
 * assignment, and emailVerified=false via the Admin API; created users are
 * deleted in afterAll (no orphaned users — FR-005).
 *
 * Email delivery is out of scope (dev mail capture receives it); the test asserts
 * only the identity-provider verification state, per US5's note.
 */
import { randomUUID } from 'node:crypto';
import {
  deleteTestUser,
  getUserById,
  getUserClientRoles,
} from './helpers/keycloak-test-client';
import { createBffClient } from './helpers/bff-test-server';

const bff = createBffClient();

// Username must be 3–20 alphanumeric/underscore (isValidUsername) — no hyphens.
const uniqueSuffix = () => randomUUID().replace(/-/g, '').slice(0, 10);
const STRONG_PASSWORD = 'IntegrationP@ss123!';

function registerBody(suffix: string, password = STRONG_PASSWORD) {
  return {
    username: `intreg_${suffix}`,
    email: `intreg_${suffix}@test.invalid`,
    firstName: 'Int',
    lastName: 'Reg',
    password,
  };
}

describe('/bff-api/auth/register — integration (real BFF + Keycloak Admin)', () => {
  const createdUserIds: string[] = [];

  afterAll(async () => {
    for (const id of createdUserIds) await deleteTestUser(id);
  });

  it('creates a Keycloak user with mc-user role and emailVerified=false (US5-AC1)', async () => {
    const res = await bff.post('/bff-api/auth/register', registerBody(uniqueSuffix()));
    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
    const userId = res.data.userId as string;
    expect(userId).toBeTruthy();
    createdUserIds.push(userId);

    const user = await getUserById(userId);
    expect(user.emailVerified).toBe(false);
    expect(user.enabled).toBe(true);
    expect(await getUserClientRoles(userId)).toContain('mc-user');
  });

  it('returns 409 for a duplicate username (US5-AC2)', async () => {
    const body = registerBody(uniqueSuffix());

    const first = await bff.post('/bff-api/auth/register', body);
    expect(first.status).toBe(201);
    createdUserIds.push(first.data.userId);

    // Same username, different email → duplicate username conflict.
    const dup = await bff.post('/bff-api/auth/register', {
      ...body,
      email: `intreg_${uniqueSuffix()}@test.invalid`,
    });
    expect(dup.status).toBe(409);
    expect(['DUPLICATE_USERNAME', 'DUPLICATE_EMAIL']).toContain(dup.data.code);
  });

  it('returns 400 WEAK_PASSWORD for a password failing policy (US5-AC3)', async () => {
    const res = await bff.post('/bff-api/auth/register', registerBody(uniqueSuffix(), 'weak'));
    expect(res.status).toBe(400);
    expect(res.data.code).toBe('WEAK_PASSWORD');
  });
});
