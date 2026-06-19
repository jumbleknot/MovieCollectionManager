/**
 * agent-rate-limiter unit tests (T041) — US5 per-user cost ceiling override (FR-020a / SC-011).
 *
 * Cost accrual lives in Redis (real-Redis behavior is covered by the integration suite); here we
 * mock cache-service so we can assert the ceiling SELECTION logic in isolation:
 *   - an explicit `ceilingOverrideUsd` governs the breach decision when provided;
 *   - the global `env.agentSessionCostCeilingUsd` governs when no override is passed;
 *   - the accrual key is still read by userId (unchanged from the no-override path).
 */

jest.mock('@/bff-server/cache-service', () => ({
  incrementRateLimit: jest.fn(),
  addAgentCostMicros: jest.fn(),
  getAgentCostMicros: jest.fn(),
}));

import { enforceAgentCostCeiling } from '@/bff-server/agent-rate-limiter';
import { getAgentCostMicros } from '@/bff-server/cache-service';
import { RateLimitError } from '@/types/errors';
import { env } from '@/config/env';

const mockGet = getAgentCostMicros as jest.MockedFunction<typeof getAgentCostMicros>;
const USD_TO_MICROS = 1_000_000;

describe('enforceAgentCostCeiling — per-user override (US5)', () => {
  beforeEach(() => mockGet.mockReset());

  it('uses the override ceiling when provided — breach below the global default still throws', async () => {
    // Override $0.10; accrued $0.15 — under the $0.50 global default but OVER the override.
    mockGet.mockResolvedValue(0.15 * USD_TO_MICROS);
    await expect(enforceAgentCostCeiling('user-a', 0.1)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('uses the override ceiling when provided — accrual under the override is allowed', async () => {
    mockGet.mockResolvedValue(0.05 * USD_TO_MICROS);
    await expect(enforceAgentCostCeiling('user-a', 0.1)).resolves.toBeUndefined();
  });

  it('falls back to the global default ceiling when no override is given', async () => {
    expect(env.agentSessionCostCeilingUsd).toBe(0.5);
    // Accrued $0.15 — under the override-less default; allowed.
    mockGet.mockResolvedValue(0.15 * USD_TO_MICROS);
    await expect(enforceAgentCostCeiling('user-a')).resolves.toBeUndefined();
    // Accrued $0.60 — over the default; throws.
    mockGet.mockResolvedValue(0.6 * USD_TO_MICROS);
    await expect(enforceAgentCostCeiling('user-a')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('reads the accrued cost by userId (accrual key unchanged)', async () => {
    mockGet.mockResolvedValue(0);
    await enforceAgentCostCeiling('user-xyz', 0.25);
    expect(mockGet).toHaveBeenCalledWith('user-xyz');
  });
});
