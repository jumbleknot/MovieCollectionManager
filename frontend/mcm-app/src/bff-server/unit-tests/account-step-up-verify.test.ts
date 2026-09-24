/**
 * Step-up verification refusals (feature 076, T026 — FR-009, FR-010, FR-012).
 *
 * Five ways a proof can be wrong, and every one of them must destroy nothing.
 *
 * The `missing_auth_time` case is written first on purpose. It is the check most likely to be
 * implemented the wrong way round — `if (authTime && stale) reject` reads naturally and passes
 * an absent claim straight through — and its failure is silent: the deletion proceeds, looks
 * correct, and the re-authentication requirement has quietly bought nothing.
 *
 * A failed verification also CONSUMES the pending record. A proof that did not satisfy the
 * checks must not be retryable against the same request.
 */

const mockTake = jest.fn();
jest.mock('@/bff-server/cache-service', () => ({
  takePendingAccountDeletion: (...a: unknown[]) => mockTake(...a),
}));

jest.mock('@/bff-server/logger', () => ({
  logger: { audit: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { verifyStepUpProof } from '@/bff-server/account-step-up';

const NOW = 1_800_000_000;
const FLOOR = NOW - 3600;

function pending(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    state: 'the-state',
    codeVerifier: 'verifier',
    redirectUri: 'http://localhost:8082/bff-api/account/delete',
    authTimeFloor: FLOOR,
    requestedAt: NOW - 10,
    ...overrides,
  });
}

/** A stand-in for the code exchange, so no network is involved. */
function exchangeReturning(idClaims: Record<string, unknown>) {
  return jest.fn(async () => ({
    idClaims,
    accessToken: 'step-up-access',
    refreshToken: 'step-up-refresh',
  }));
}

const fresh = { sub: 'user-1', auth_time: NOW - 5 };

function run(opts: {
  stored?: string | null;
  state?: string;
  claims?: Record<string, unknown>;
  exchange?: jest.Mock;
}) {
  mockTake.mockResolvedValue(opts.stored === undefined ? pending() : opts.stored);
  return verifyStepUpProof({
    userId: 'user-1',
    code: 'the-code',
    state: opts.state ?? 'the-state',
    now: NOW,
    exchange: opts.exchange ?? exchangeReturning(opts.claims ?? fresh),
  });
}

beforeEach(() => jest.clearAllMocks());

describe('verifyStepUpProof — refusals', () => {
  it('refuses a proof whose auth_time claim is ABSENT', async () => {
    const result = await run({ claims: { sub: 'user-1' } });

    expect(result).toMatchObject({ ok: false, reason: 'missing_auth_time' });
  });

  it('refuses when no request is pending', async () => {
    const result = await run({ stored: null });

    expect(result).toMatchObject({ ok: false, reason: 'no_pending' });
  });

  it('refuses when the state does not match', async () => {
    const result = await run({ state: 'forged' });

    expect(result).toMatchObject({ ok: false, reason: 'state_mismatch' });
  });

  it('refuses when the proof belongs to a different account', async () => {
    const result = await run({ claims: { sub: 'someone-else', auth_time: NOW - 5 } });

    expect(result).toMatchObject({ ok: false, reason: 'subject_mismatch' });
  });

  it('refuses an authentication older than the freshness window', async () => {
    const result = await run({ claims: { sub: 'user-1', auth_time: NOW - 400 } });

    expect(result).toMatchObject({ ok: false, reason: 'stale_auth' });
  });

  it('refuses an auth_time that did not advance past the session it started from', async () => {
    const result = await run({ claims: { sub: 'user-1', auth_time: FLOOR } });

    expect(result).toMatchObject({ ok: false, reason: 'stale_auth' });
  });

  it('consumes the pending record even when the proof is refused', async () => {
    await run({ state: 'forged' });

    expect(mockTake).toHaveBeenCalledWith('user-1');
  });

  it('does not exchange the code when the state already failed', async () => {
    const exchange = exchangeReturning(fresh);

    await run({ state: 'forged', exchange });

    expect(exchange).not.toHaveBeenCalled();
  });
});

describe('verifyStepUpProof — acceptance', () => {
  it('accepts a fresh, matching, single-use proof and returns the step-up tokens', async () => {
    const result = await run({});

    expect(result).toMatchObject({
      ok: true,
      accessToken: 'step-up-access',
      refreshToken: 'step-up-refresh',
    });
  });

  it('exchanges with the parked verifier and redirect URI, not values from the request', async () => {
    const exchange = exchangeReturning(fresh);

    await run({ exchange });

    expect(exchange).toHaveBeenCalledWith(
      'the-code',
      'verifier',
      'http://localhost:8082/bff-api/account/delete',
    );
  });

  it('accepts an auth_time at the very edge of the window', async () => {
    const result = await run({ claims: { sub: 'user-1', auth_time: NOW - 299 } });

    expect(result).toMatchObject({ ok: true });
  });
});
