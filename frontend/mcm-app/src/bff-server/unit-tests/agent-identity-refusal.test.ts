/**
 * The agent routes refuse a turn they cannot attribute (feature 085, item #844 — FR-001..FR-004).
 *
 * Before 085 a refused subject-token mint was logged and the turn ran WITHOUT identity, so the
 * member saw "No caller identity is available for this action" from deep inside the assistant and
 * gate-tier CI failed on unrelated changes. Now the refusal becomes the route's response, produced
 * before the gateway is ever reached: the gateway factories are spies, and "no step ran" is "the
 * spy was never called".
 *
 * The REAL `AgentIdentityError` and the REAL `handleMcApiError` are used, so the status, code and
 * Retry-After asserted here are the ones a client receives.
 */

import { ClientRole } from '@/types/auth';
import type { UserProfile } from '@/types/auth';

const mockRequireAuth = jest.fn();
jest.mock('@/bff-server/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

jest.mock('@/bff-server/request-context', () => ({
  withRequestContext: (fn: () => Promise<unknown>) => fn(),
  getRequestId: () => undefined,
}));

let mockExchangeConfigured = true;
const mockMintSubjectToken = jest.fn();
jest.mock('@/bff-server/agent-subject-token', () => ({
  ...jest.requireActual('@/bff-server/agent-subject-token'),
  isSubjectTokenExchangeConfigured: () => mockExchangeConfigured,
  mintSubjectToken: (...args: unknown[]) => mockMintSubjectToken(...args),
}));

jest.mock('@/bff-server/agent-config-service', () => ({
  resolveForRun: jest.fn(async () => ({ provider: 'ollama', costLimitUsd: null })),
}));
jest.mock('@/bff-server/agent-thread-owner', () => ({
  enforceAgentThreadOwnership: jest.fn(async () => undefined),
}));
jest.mock('@/bff-server/audit-sink', () => ({ audit: jest.fn() }));
jest.mock('@/bff-server/logger', () => ({
  logger: { audit: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/bff-server/cache-service', () => ({
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

const mockCreateMovieAssistantAgent = jest.fn((_options: { subjectToken?: string }) => ({ agent: true }));
const mockResumeMovieAssistantRun = jest.fn(async (_options: { subjectToken?: string }) => new Response('{}'));
jest.mock('@/bff-server/agent-gateway-client', () => ({
  createMovieAssistantAgent: (options: { subjectToken?: string }) => mockCreateMovieAssistantAgent(options),
  resumeMovieAssistantRun: (options: { subjectToken?: string }) => mockResumeMovieAssistantRun(options),
}));

jest.mock('@copilotkit/runtime', () => ({
  CopilotRuntime: class {},
  ExperimentalEmptyAdapter: class {},
  copilotRuntimeNextJSAppRouterEndpoint: () => ({
    handleRequest: async () => new Response('{}', { status: 200 }),
  }),
}));

import { POST as runPost } from '@/app/bff-api/agent/run+api';
import { POST as resumePost } from '@/app/bff-api/agent/resume+api';
import { AgentIdentityError } from '@/bff-server/agent-subject-token';

function member(): UserProfile {
  return {
    id: 'user-uuid',
    username: 'viewer',
    email: 'viewer@example.com',
    firstName: 'V',
    lastName: 'R',
    roles: [ClientRole.MCUser],
    emailVerified: true,
    accountStatus: 'active',
    createdAt: new Date().toISOString(),
  };
}

const noHeaders = { entries: () => Object.entries({})[Symbol.iterator]() };

/** A billable CopilotKit turn — the run that would execute assistant steps. */
function billableRun(): Request {
  const body = JSON.stringify({ operationName: 'generateCopilotResponse', variables: {} });
  return { headers: noHeaders, clone: () => ({ text: async () => body }) } as unknown as Request;
}

function resume(): Request {
  const body = { threadId: 't-1', proposalId: 'p-1', decision: 'approved' };
  return { headers: noHeaders, json: async () => body } as unknown as Request;
}

const ROUTES = [
  ['start a turn', () => runPost(billableRun()), mockCreateMovieAssistantAgent],
  ['resume a paused turn', () => resumePost(resume()), mockResumeMovieAssistantRun],
] as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockExchangeConfigured = true;
  mockRequireAuth.mockResolvedValue({ user: member(), payload: { sub: 'user-uuid' }, accessToken: 'member-access-token' });
});

describe.each(ROUTES)('agent route — %s', (_label, call, gateway) => {
  it('an auth refusal is 401 AGENT_IDENTITY_REJECTED, and no assistant step runs (FR-001, FR-003)', async () => {
    mockMintSubjectToken.mockRejectedValueOnce(new AgentIdentityError('auth', 400));
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'AGENT_IDENTITY_REJECTED' });
    expect(gateway).not.toHaveBeenCalled();
  });

  it('a transient refusal is a retryable 503, distinct from auth, and no step runs (FR-002, FR-003)', async () => {
    mockMintSubjectToken.mockRejectedValueOnce(new AgentIdentityError('transient', 503));
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toMatchObject({ code: 'AGENT_IDENTITY_UNAVAILABLE' });
    expect(gateway).not.toHaveBeenCalled();
  });

  it('with run-scoped identity unconfigured, the turn runs as before (FR-004)', async () => {
    mockExchangeConfigured = false;
    await call();
    expect(mockMintSubjectToken).not.toHaveBeenCalled();
    expect(gateway).toHaveBeenCalledWith(expect.objectContaining({ subjectToken: undefined }));
  });

  it('a minted identity is handed to the gateway', async () => {
    mockMintSubjectToken.mockResolvedValueOnce({ token: 'run-scoped', expiresIn: 120 });
    await call();
    expect(gateway).toHaveBeenCalledWith(expect.objectContaining({ subjectToken: 'run-scoped' }));
  });
});
