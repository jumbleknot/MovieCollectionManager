/**
 * Unit tests for the agent assistant rate/cost limiter (T027).
 *
 * Provenance: FR-020a (per-user request rate limit + per-user/session cost
 * ceiling; breach → friendly "try again later", no action) / SC-011. Thresholds
 * from plan.md: 20 requests / 60 s; $0.50 / session ceiling. Mirrors the existing
 * `rate-limiter.ts` Redis-counter pattern; cost is tracked in integer micro-USD so
 * the exact `incr`/`expire`-on-first fixed-window pattern can be reused.
 */

import {
  checkAgentRequestRateLimit,
  enforceAgentCostCeiling,
  recordAgentCost,
  recordEstimatedTurnCost,
} from '@/bff-server/agent-rate-limiter';
import { env } from '@/config/env';
import {
  incrementRateLimit,
  getAgentCostMicros,
  addAgentCostMicros,
} from '@/bff-server/cache-service';
import { RateLimitError } from '@/types/errors';

jest.mock('@/bff-server/cache-service', () => ({
  incrementRateLimit: jest.fn(),
  getAgentCostMicros: jest.fn(),
  addAgentCostMicros: jest.fn(),
}));

const mockedIncrement = incrementRateLimit as jest.MockedFunction<typeof incrementRateLimit>;
const mockedGetCost = getAgentCostMicros as jest.MockedFunction<typeof getAgentCostMicros>;
const mockedAddCost = addAgentCostMicros as jest.MockedFunction<typeof addAgentCostMicros>;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkAgentRequestRateLimit (per-user request limit, 20 / 60 s)', () => {
  it('allows requests within the limit, keyed by user id', async () => {
    mockedIncrement.mockResolvedValue(20);
    await expect(checkAgentRequestRateLimit('user-1')).resolves.toBeUndefined();
    expect(mockedIncrement).toHaveBeenCalledWith('agent-run', 'user-1', 60);
  });

  it('throws RateLimitError when the per-user request limit is exceeded', async () => {
    mockedIncrement.mockResolvedValue(21); // > 20 default limit
    await expect(checkAgentRequestRateLimit('user-1')).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('enforceAgentCostCeiling (per-user/session cost ceiling, $0.50)', () => {
  it('allows when accrued cost is below the ceiling', async () => {
    mockedGetCost.mockResolvedValue(400_000); // $0.40
    await expect(enforceAgentCostCeiling('user-1')).resolves.toBeUndefined();
    expect(mockedGetCost).toHaveBeenCalledWith('user-1');
  });

  it('throws RateLimitError (no action) when accrued cost has reached the ceiling', async () => {
    mockedGetCost.mockResolvedValue(500_000); // $0.50 == ceiling
    await expect(enforceAgentCostCeiling('user-1')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('throws RateLimitError when accrued cost exceeds the ceiling', async () => {
    mockedGetCost.mockResolvedValue(750_000); // $0.75
    await expect(enforceAgentCostCeiling('user-1')).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe('recordAgentCost (accrues per-turn cost against the session budget)', () => {
  it('converts USD to integer micro-USD and accrues against the user budget', async () => {
    await recordAgentCost('user-1', 0.03);
    expect(mockedAddCost).toHaveBeenCalledWith('user-1', 30_000, expect.any(Number));
  });

  it('ignores zero or negative cost (no accrual)', async () => {
    await recordAgentCost('user-1', 0);
    await recordAgentCost('user-1', -1);
    expect(mockedAddCost).not.toHaveBeenCalled();
  });
});

describe('recordEstimatedTurnCost (closes the SC-011 cost-ceiling loop)', () => {
  it('accrues the configured per-turn estimate so the ceiling actually trips', async () => {
    // The real per-turn cost lives in the (opt-in) observability stack; in the default config
    // the BFF accrues a fixed estimate per billable turn so spend is bounded (FR-020a). The
    // estimate is positive by default, so it MUST accrue.
    await recordEstimatedTurnCost('user-1');
    const expectedMicros = Math.round(env.agentEstimatedTurnCostUsd * 1_000_000);
    expect(expectedMicros).toBeGreaterThan(0);
    expect(mockedAddCost).toHaveBeenCalledWith('user-1', expectedMicros, expect.any(Number));
  });
});
