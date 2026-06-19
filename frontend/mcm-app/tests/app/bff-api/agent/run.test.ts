/**
 * T012 — /bff-api/agent/run short-circuit unit tests (US1, FR-002).
 *
 * A billable run for a user whose config is not runnable MUST short-circuit with a typed
 * `assistant_not_configured` response (HTTP 200) BEFORE any rate-limit/cost accrual or
 * gateway call — no model, no cost (SC-001/SC-002). A runnable user proceeds normally.
 */

const mockHandleRequest = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }));

jest.mock('@copilotkit/runtime', () => ({
  CopilotRuntime: jest.fn().mockImplementation(() => ({})),
  ExperimentalEmptyAdapter: jest.fn().mockImplementation(() => ({})),
  copilotRuntimeNextJSAppRouterEndpoint: jest.fn(() => ({ handleRequest: mockHandleRequest })),
}));

jest.mock('@/bff-server/auth', () => ({
  requireAuth: jest.fn(),
  extractRawToken: jest.fn().mockReturnValue('raw-jwt'),
}));
jest.mock('@/bff-server/request-context', () => ({
  withRequestContext: jest.fn((fn: () => unknown) => fn()),
}));
jest.mock('@/bff-server/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn(), audit: jest.fn() },
}));
jest.mock('@/bff-server/audit-sink', () => ({ audit: jest.fn() }));
jest.mock('@/bff-server/agent-gateway-client', () => ({
  createMovieAssistantAgent: jest.fn(() => ({})),
}));
jest.mock('@/bff-server/agent-subject-token', () => ({
  mintSubjectToken: jest.fn(),
  isSubjectTokenExchangeConfigured: jest.fn(() => false),
}));
jest.mock('@/bff-server/agent-rate-limiter', () => ({
  checkAgentRequestRateLimit: jest.fn(),
  enforceAgentCostCeiling: jest.fn(),
  recordEstimatedTurnCost: jest.fn(),
  isBillableAgentRun: jest.fn(() => true),
}));
jest.mock('@/bff-server/agent-thread-owner', () => ({ enforceAgentThreadOwnership: jest.fn() }));
jest.mock('@/bff-server/agent-resume', () => ({
  extractApprovalDecision: jest.fn(() => null),
  extractThreadId: jest.fn(() => undefined),
}));
jest.mock('@/bff-server/cache-service', () => ({
  getAgentUiSnapshot: jest.fn(), getAgentImportFile: jest.fn(), clearAgentImportFile: jest.fn(),
}));
jest.mock('@/bff-server/agent-config-service', () => ({ resolveForRun: jest.fn() }));

import { POST } from '@/app/bff-api/agent/run+api';
import { requireAuth } from '@/bff-server/auth';
import { resolveForRun } from '@/bff-server/agent-config-service';
import { createMovieAssistantAgent } from '@/bff-server/agent-gateway-client';
import {
  checkAgentRequestRateLimit,
  recordEstimatedTurnCost,
} from '@/bff-server/agent-rate-limiter';

const mockUser = { id: 'user-1', username: 'u', roles: ['mc-user'], accountStatus: 'active' as const, createdAt: '2026-01-01T00:00:00.000Z' };

function makePost(): Parameters<typeof POST>[0] {
  return {
    url: 'http://localhost/bff-api/agent/run',
    headers: new Headers({ cookie: 'mcm_access_token=tok' }),
    clone: () => ({ text: () => Promise.resolve('{"operationName":"generateCopilotResponse"}') }),
  } as unknown as Parameters<typeof POST>[0];
}

describe('/bff-api/agent/run — assistant_not_configured short-circuit (US1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (requireAuth as jest.Mock).mockResolvedValue({ payload: { sub: 'user-1' }, user: mockUser });
  });

  it('short-circuits a billable run when the config is not runnable, with no cost or gateway call', async () => {
    (resolveForRun as jest.Mock).mockResolvedValue(null);

    const res = await POST(makePost());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 'assistant_not_configured' });
    expect(createMovieAssistantAgent).not.toHaveBeenCalled();
    expect(recordEstimatedTurnCost).not.toHaveBeenCalled();
    expect(checkAgentRequestRateLimit).not.toHaveBeenCalled();
  });

  it('proceeds to the gateway when the config is runnable', async () => {
    (resolveForRun as jest.Mock).mockResolvedValue({
      provider: 'ollama', ollamaBaseUrl: 'http://localhost:11434', tmdbKey: 'k',
    });

    const res = await POST(makePost());

    expect(res.status).toBe(200);
    expect(createMovieAssistantAgent).toHaveBeenCalled();
    expect(recordEstimatedTurnCost).toHaveBeenCalledWith('user-1');
  });
});
