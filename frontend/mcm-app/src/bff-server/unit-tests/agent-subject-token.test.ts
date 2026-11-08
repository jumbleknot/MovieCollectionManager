/**
 * T023 — agent-subject-token: the BFF's RFC 8693 run-scoped subject-token mint.
 *
 * Per run invocation / HITL resume the BFF exchanges the user's session access token
 * for a run-scoped, audience-narrowed delegation token (short TTL, agent-origin marker)
 * and supplies THAT to the gateway — never the user's full session token (research R3,
 * MCM-Architecture §Token Custody). The exchanged token is ephemeral: never logged,
 * never checkpointed (SC-004).
 */

import {
  mintSubjectToken,
  isSubjectTokenExchangeConfigured,
  SUBJECT_TOKEN_MAX_TTL_SECONDS,
  AgentIdentityError,
} from '@/bff-server/agent-subject-token';
import { AuthError, AuthErrorCode } from '@/types/errors';
import { logger } from '@/bff-server/logger';

global.fetch = jest.fn();
const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

const ENV_KEYS = [
  'AGENT_SUBJECT_TOKEN_CLIENT_ID',
  'AGENT_SUBJECT_TOKEN_CLIENT_SECRET',
  'AGENT_SUBJECT_TOKEN_AUDIENCE',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.AGENT_SUBJECT_TOKEN_CLIENT_ID = 'agent-subject-token';
  process.env.AGENT_SUBJECT_TOKEN_CLIENT_SECRET = 'shh-secret';
  process.env.AGENT_SUBJECT_TOKEN_AUDIENCE = 'agent-gateway';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function tokenResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  } as unknown as Response;
}

const USER_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.usersig';

describe('isSubjectTokenExchangeConfigured', () => {
  it('is true when client id + secret are present', () => {
    expect(isSubjectTokenExchangeConfigured()).toBe(true);
  });

  it('is false when the client secret is missing', () => {
    delete process.env.AGENT_SUBJECT_TOKEN_CLIENT_SECRET;
    expect(isSubjectTokenExchangeConfigured()).toBe(false);
  });
});

describe('mintSubjectToken', () => {
  it('performs an RFC 8693 token-exchange with the user token as subject_token, narrowed to the gateway audience', async () => {
    mockedFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'exchanged-tok', expires_in: 120 }),
    );

    await mintSubjectToken(USER_TOKEN);

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(String(url)).toContain('/protocol/openid-connect/token');
    const body = new URLSearchParams(String((init as RequestInit).body));
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.get('subject_token')).toBe(USER_TOKEN);
    expect(body.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token');
    expect(body.get('audience')).toBe('agent-gateway');
    expect(body.get('client_id')).toBe('agent-subject-token');
    expect(body.get('client_secret')).toBe('shh-secret');
  });

  it('returns the exchanged token and its expiry', async () => {
    mockedFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'exchanged-tok', expires_in: 120 }),
    );
    const result = await mintSubjectToken(USER_TOKEN);
    expect(result.token).toBe('exchanged-tok');
    expect(result.expiresIn).toBe(120);
  });

  it('caps expiry at the hard TTL ceiling even if Keycloak returns a longer lifespan', async () => {
    mockedFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'exchanged-tok', expires_in: 3600 }),
    );
    const result = await mintSubjectToken(USER_TOKEN);
    expect(result.expiresIn).toBe(SUBJECT_TOKEN_MAX_TTL_SECONDS);
    expect(SUBJECT_TOKEN_MAX_TTL_SECONDS).toBeLessThanOrEqual(180);
  });

  it('throws a typed AuthError when the exchange is rejected', async () => {
    mockedFetch.mockResolvedValueOnce(tokenResponse({ error: 'access_denied' }, 400));
    await expect(mintSubjectToken(USER_TOKEN)).rejects.toBeInstanceOf(AuthError);
  });

  it('throws when token exchange is not configured', async () => {
    delete process.env.AGENT_SUBJECT_TOKEN_CLIENT_SECRET;
    await expect(mintSubjectToken(USER_TOKEN)).rejects.toBeInstanceOf(AuthError);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('never logs the raw subject or exchanged token (SC-004)', async () => {
    const errorSpy = jest.spyOn(logger, 'error');
    const auditSpy = jest.spyOn(logger, 'audit');
    mockedFetch.mockResolvedValueOnce(
      tokenResponse({ access_token: 'exchanged-tok', expires_in: 120 }),
    );

    await mintSubjectToken(USER_TOKEN);

    for (const spy of [errorSpy, auditSpy]) {
      for (const call of spy.mock.calls) {
        const serialized = JSON.stringify(call);
        expect(serialized).not.toContain('exchanged-tok');
        expect(serialized).not.toContain(USER_TOKEN);
      }
    }
  });
});

// Feature 085 (item #844, FR-001/FR-002/FR-005): a refused mint is classified, so the run route can
// refuse the turn the right way — an auth failure the client renews from, or a retryable outage —
// instead of running the turn without identity.
describe('mintSubjectToken — refusal classification (feature 085)', () => {
  async function refusal(): Promise<AgentIdentityError> {
    try {
      await mintSubjectToken(USER_TOKEN);
    } catch (err) {
      if (err instanceof AgentIdentityError) return err;
      throw new Error(`expected AgentIdentityError, got ${String(err)}`);
    }
    throw new Error('expected the mint to be refused');
  }

  it.each([
    ['400 invalid_token', tokenResponse({ error: 'invalid_token' }, 400)],
    ['400 invalid_grant', tokenResponse({ error: 'invalid_grant' }, 400)],
    ['401 invalid_token', tokenResponse({ error: 'invalid_token' }, 401)],
    // MEASURED against Keycloak 26.5 standard token exchange (085 T010): a revoked or malformed
    // subject token is answered 400 invalid_request "Invalid token", not invalid_token.
    [
      '400 invalid_request "Invalid token" (Keycloak 26.5)',
      tokenResponse({ error: 'invalid_request', error_description: 'Invalid token' }, 400),
    ],
  ])('%s is an auth refusal: 401 AGENT_IDENTITY_REJECTED', async (_label, res) => {
    mockedFetch.mockResolvedValueOnce(res);
    const err = await refusal();
    expect(err.outcome).toBe('auth');
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe(AuthErrorCode.AGENT_IDENTITY_REJECTED);
  });

  it.each([
    ['503', () => mockedFetch.mockResolvedValueOnce(tokenResponse({}, 503))],
    ['500', () => mockedFetch.mockResolvedValueOnce(tokenResponse({}, 500))],
    [
      '400 invalid_request about configuration, not the credential',
      () =>
        mockedFetch.mockResolvedValueOnce(
          tokenResponse(
            {
              error: 'invalid_request',
              error_description: 'Requested audience not available: agent-gateway',
            },
            400,
          ),
        ),
    ],
    [
      '403 access_denied (misconfigured exchange client)',
      () => mockedFetch.mockResolvedValueOnce(tokenResponse({ error: 'access_denied' }, 403)),
    ],
    ['a network error', () => mockedFetch.mockRejectedValueOnce(new TypeError('fetch failed'))],
    [
      'a timeout',
      () =>
        mockedFetch.mockRejectedValueOnce(
          Object.assign(new Error('The operation was aborted due to timeout'), {
            name: 'TimeoutError',
          }),
        ),
    ],
  ])(
    '%s is transient: 503 AGENT_IDENTITY_UNAVAILABLE with Retry-After',
    async (_label, arrange) => {
      arrange();
      const err = await refusal();
      expect(err.outcome).toBe('transient');
      expect(err.statusCode).toBe(503);
      expect(err.code).toBe(AuthErrorCode.AGENT_IDENTITY_UNAVAILABLE);
      expect(err.retryAfterSeconds).toBe(5);
    },
  );

  it('bounds the exchange with a timeout signal', async () => {
    mockedFetch.mockResolvedValueOnce(tokenResponse({ access_token: 'x', expires_in: 60 }));
    await mintSubjectToken(USER_TOKEN);
    const init = mockedFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('logs agent_identity_refused with the outcome and status, and no token or body', async () => {
    const warnSpy = jest.spyOn(logger, 'warn');
    const errorSpy = jest.spyOn(logger, 'error');
    mockedFetch.mockResolvedValueOnce(
      tokenResponse({ error: 'invalid_token', error_description: 'secret-ish detail' }, 400),
    );
    await refusal();
    mockedFetch.mockResolvedValueOnce(tokenResponse({ error: 'boom' }, 503));
    await refusal();

    const calls = [...warnSpy.mock.calls, ...errorSpy.mock.calls];
    const refused = calls.filter(([msg]) => msg === 'agent_identity_refused');
    expect(refused.map(([, ctx]) => ctx)).toEqual([
      expect.objectContaining({ outcome: 'auth', status: 400 }),
      expect.objectContaining({ outcome: 'transient', status: 503 }),
    ]);
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(USER_TOKEN);
    expect(serialized).not.toContain('secret-ish detail');
  });
});
