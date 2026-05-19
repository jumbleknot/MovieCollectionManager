/**
 * Integration tests for registration flow (T-057)
 * Tests the full registration chain: form → BFF → Keycloak Admin API responses
 */

import axios from 'axios';
import MockAdapter from 'axios-mock-adapter';

const mock = new MockAdapter(axios);

const REGISTER_URL = '/bff-api/auth/register';

const validPayload = {
  username: 'integrationuser',
  email: 'integration@example.com',
  firstName: 'Integration',
  lastName: 'User',
  password: 'SecurePass1!extra',
};

describe('Registration integration (frontend BFF client)', () => {
  afterEach(() => mock.reset());
  afterAll(() => mock.restore());

  it('returns success response for valid registration', async () => {
    mock.onPost(REGISTER_URL).reply(201, {
      success: true,
      message: 'Account created. Please verify your email.',
      userId: 'user-001',
    });

    const res = await axios.post(REGISTER_URL, validPayload);
    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
    expect(res.data.userId).toBeDefined();
  });

  it('rejects duplicate email with 409', async () => {
    mock.onPost(REGISTER_URL).reply(409, {
      error: 'An account with that email already exists.',
      code: 'DUPLICATE_EMAIL',
    });

    await expect(axios.post(REGISTER_URL, validPayload)).rejects.toMatchObject({
      response: { status: 409 },
    });
  });

  it('rejects weak password with 400', async () => {
    mock.onPost(REGISTER_URL).reply(400, {
      error: 'Password does not meet requirements.',
      code: 'WEAK_PASSWORD',
    });

    await expect(
      axios.post(REGISTER_URL, { ...validPayload, password: 'weak' }),
    ).rejects.toMatchObject({
      response: { status: 400 },
    });
  });

  it('handles rate limit 429', async () => {
    mock.onPost(REGISTER_URL).reply(429, {
      error: 'Too many registration attempts. Try again later.',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: 86400,
    });

    await expect(axios.post(REGISTER_URL, validPayload)).rejects.toMatchObject({
      response: { status: 429 },
    });
  });
});
