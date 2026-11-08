/**
 * `agent/stop` is bound to the thread's owner like `run` and `resume` (spec 097, item #964 part 2).
 *
 * The route is driven end to end through the REAL `extractThreadId` and the REAL
 * `enforceAgentThreadOwnership`; only the Redis claim underneath is an in-memory map with the same
 * SET-NX semantics. So the assertion is the observable one: B's stop never reaches the runtime.
 * Before the fix, `extractThreadId` read only `body.threadId`, a stop names its thread in
 * `params.threadId`, and the ownership check saw "no thread" and let it through.
 */

import { ClientRole } from '@/types/auth';
import type { UserProfile } from '@/types/auth';
import { ForbiddenError } from '@/types/errors';

const mockRequireAuth = jest.fn();
jest.mock('@/bff-server/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

jest.mock('@/bff-server/request-context', () => ({
  withRequestContext: (fn: () => Promise<unknown>) => fn(),
}));

jest.mock('@/bff-server/security-headers', () => ({ securityHeaders: () => new Headers() }));

// Rethrow, so the refusal is observed as the typed error rather than a mapped 403 body.
jest.mock('@/bff-server/mc-api-error', () => ({
  handleMcApiError: (err: unknown) => {
    throw err;
  },
}));

jest.mock('@/bff-server/agent-subject-token', () => ({
  isSubjectTokenExchangeConfigured: () => false,
  mintSubjectToken: jest.fn(),
}));

jest.mock('@/bff-server/agent-config-service', () => ({
  resolveForRun: jest.fn(async () => ({ costLimitUsd: null })),
}));

jest.mock('@/bff-server/audit-sink', () => ({ audit: jest.fn() }));
jest.mock('@/bff-server/logger', () => ({
  logger: { audit: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

// The claim store: `SET key user NX`, then read the owner back — what `claimAgentThreadOwner` does.
const mockOwners = new Map<string, string>();
jest.mock('@/bff-server/cache-service', () => ({
  claimAgentThreadOwner: jest.fn(async (threadId: string, userId: string) => {
    if (!mockOwners.has(threadId)) mockOwners.set(threadId, userId);
    return mockOwners.get(threadId);
  }),
  getAgentUiSnapshot: jest.fn(async () => null),
  getAgentImportFile: jest.fn(async () => null),
  clearAgentImportFile: jest.fn(async () => undefined),
}));

jest.mock('@/bff-server/agent-rate-limiter', () => ({
  ...jest.requireActual('@/bff-server/agent-rate-limiter'),
  checkAgentRequestRateLimit: jest.fn(async () => undefined),
  enforceAgentCostCeiling: jest.fn(async () => undefined),
  recordEstimatedTurnCost: jest.fn(async () => undefined),
}));

jest.mock('@/bff-server/agent-gateway-client', () => ({
  createMovieAssistantAgent: jest.fn(() => ({ agent: true })),
}));

const mockHandleRequest = jest.fn(async () => new Response('{}', { status: 200 }));
jest.mock('@copilotkit/runtime', () => ({
  CopilotRuntime: class {},
  ExperimentalEmptyAdapter: class {},
  copilotRuntimeNextJSAppRouterEndpoint: () => ({ handleRequest: () => mockHandleRequest() }),
}));

import { POST } from '@/app/bff-api/agent/run+api';

function user(id: string): UserProfile {
  return {
    id,
    username: id,
    email: `${id}@example.com`,
    firstName: 'U',
    lastName: id,
    roles: [ClientRole.MCUser],
    emailVerified: true,
    accountStatus: 'active',
    createdAt: new Date().toISOString(),
  };
}

/** A single-route envelope POST, the shape `createCopilotEndpointSingleRoute` parses. */
function envelope(payload: unknown): Request {
  const text = JSON.stringify(payload);
  return {
    headers: { entries: () => Object.entries({})[Symbol.iterator]() },
    clone: () => ({ text: async () => text }),
  } as unknown as Request;
}

const THREAD = '6f1c2a9e-3b7d-4c55-9a0e-2d8f1b4c7e90';

const runAs = (id: string) => {
  mockRequireAuth.mockResolvedValue({ user: user(id) });
  return POST(
    envelope({
      method: 'agent/run',
      params: { agentId: 'movie_assistant' },
      body: { threadId: THREAD, runId: 'run-1', messages: [] },
    }),
  );
};

const stopAs = (id: string) => {
  mockRequireAuth.mockResolvedValue({ user: user(id) });
  return POST(
    envelope({
      method: 'agent/stop',
      params: { agentId: 'movie_assistant', threadId: THREAD },
      body: { runId: 'run-1' },
    }),
  );
};

beforeEach(() => {
  jest.clearAllMocks();
  mockOwners.clear();
});

describe('agent/stop — thread ownership', () => {
  it("user B stopping user A's thread is refused before the runtime", async () => {
    await expect(runAs('user-A')).resolves.toBeInstanceOf(Response); // A claims the thread
    expect(mockHandleRequest).toHaveBeenCalledTimes(1);

    await expect(stopAs('user-B')).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockHandleRequest).toHaveBeenCalledTimes(1); // B's stop never reached the runtime
  });

  it('the owner can stop their own thread', async () => {
    await runAs('user-A');
    await expect(stopAs('user-A')).resolves.toBeInstanceOf(Response);
    expect(mockHandleRequest).toHaveBeenCalledTimes(2);
  });
});
