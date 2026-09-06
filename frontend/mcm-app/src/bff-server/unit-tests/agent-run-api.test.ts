/**
 * Unit tests for the agent /run route's pending-import-file bridge (item #284).
 *
 * The pending import-file handle is SINGLE-USE: `resolveImportFile` clears it after reading, so it
 * bridges to exactly the next import turn. The route must therefore consume it only for a BILLABLE
 * turn — a CopilotKit handshake POST (`availableAgents` the dock issues on open, `loadAgentState`,
 * `hello`) runs no graph and must leave the handle in place for the turn that follows.
 *
 * `isBillableAgentRun` is the REAL classifier (the same signal the runtime dispatches on); the
 * limiter's Redis-backed enforcement, the gateway client, and the CopilotKit runtime are mocked.
 * `handleMcApiError` is mocked to RETHROW so an unexpected failure surfaces as the test's error
 * rather than as a swallowed 500 that looks like a routing assertion.
 */

import { ClientRole } from '@/types/auth';
import type { UserProfile } from '@/types/auth';

const mockRequireAuth = jest.fn();
jest.mock('@/bff-server/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  extractRawToken: () => undefined,
}));

jest.mock('@/bff-server/request-context', () => ({
  withRequestContext: (fn: () => Promise<unknown>) => fn(),
}));

jest.mock('@/bff-server/security-headers', () => ({
  securityHeaders: () => new Headers(),
}));

jest.mock('@/bff-server/mc-api-error', () => ({
  handleMcApiError: (err: unknown) => {
    throw err;
  },
}));

jest.mock('@/bff-server/agent-subject-token', () => ({
  isSubjectTokenExchangeConfigured: () => false,
  mintSubjectToken: jest.fn(),
}));

const mockResolveForRun = jest.fn();
jest.mock('@/bff-server/agent-config-service', () => ({
  resolveForRun: (...args: unknown[]) => mockResolveForRun(...args),
}));

jest.mock('@/bff-server/agent-thread-owner', () => ({
  enforceAgentThreadOwnership: jest.fn(async () => undefined),
}));

jest.mock('@/bff-server/audit-sink', () => ({ audit: jest.fn() }));

jest.mock('@/bff-server/logger', () => ({
  logger: { audit: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

// The transient store, backed by a mutable fixture so "consumed" is observable.
let mockImportFileRaw: string | null = null;
let mockUiSnapshotRaw: string | null = null;
const mockClearAgentImportFile = jest.fn(async (_userId: string) => {
  mockImportFileRaw = null;
});
jest.mock('@/bff-server/cache-service', () => ({
  getAgentUiSnapshot: jest.fn(async () => mockUiSnapshotRaw),
  getAgentImportFile: jest.fn(async () => mockImportFileRaw),
  clearAgentImportFile: (userId: string) => mockClearAgentImportFile(userId),
  incrementRateLimit: jest.fn(),
  getAgentCostMicros: jest.fn(),
  addAgentCostMicros: jest.fn(),
}));

// Keep the REAL isBillableAgentRun; stub only the Redis-backed enforcement.
jest.mock('@/bff-server/agent-rate-limiter', () => ({
  ...jest.requireActual('@/bff-server/agent-rate-limiter'),
  checkAgentRequestRateLimit: jest.fn(async () => undefined),
  enforceAgentCostCeiling: jest.fn(async () => undefined),
  recordEstimatedTurnCost: jest.fn(async () => undefined),
}));

type GatewayAgentOptions = { uiSnapshot?: unknown; importFile?: unknown };
const mockCreateMovieAssistantAgent = jest.fn((_options: GatewayAgentOptions) => ({ agent: true }));
jest.mock('@/bff-server/agent-gateway-client', () => ({
  createMovieAssistantAgent: (options: GatewayAgentOptions) => mockCreateMovieAssistantAgent(options),
}));

jest.mock('@copilotkit/runtime', () => ({
  CopilotRuntime: class {},
  ExperimentalEmptyAdapter: class {},
  copilotRuntimeNextJSAppRouterEndpoint: () => ({
    handleRequest: async () => new Response('{}', { status: 200 }),
  }),
}));

import { GET, POST } from '@/app/bff-api/agent/run+api';

function mcUser(): UserProfile {
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

/** A CopilotKit runtime POST carrying `operationName` — the signal the route classifies on. */
function copilotPost(operationName: string): Request {
  const body = JSON.stringify({ operationName, variables: {} });
  const req = {
    headers: { entries: () => Object.entries({})[Symbol.iterator]() },
    clone: () => ({ text: async () => body }),
  };
  return req as unknown as Request;
}

function infoGet(): Request {
  return {
    headers: { entries: () => Object.entries({})[Symbol.iterator]() },
    clone: () => ({ text: async () => '' }),
  } as unknown as Request;
}

/** The options the route handed the gateway client on its most recent call. */
function lastGatewayOptions(): GatewayAgentOptions | undefined {
  return mockCreateMovieAssistantAgent.mock.calls.at(-1)?.[0];
}

/** The `importFile` the route handed the gateway client on its most recent call. */
function importFilePassedToGateway(): unknown {
  return lastGatewayOptions()?.importFile;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockImportFileRaw = JSON.stringify({ handle: 'staged-handle', filename: 'movies.xlsx' });
  mockUiSnapshotRaw = null;
  mockRequireAuth.mockResolvedValue({ user: mcUser() });
  mockResolveForRun.mockResolvedValue({ costLimitUsd: null });
});

describe('agent /run — the pending import-file handle is consumed by a turn, not by a handshake', () => {
  it.each(['availableAgents', 'loadAgentState', 'hello'])(
    'a %s handshake POST leaves the handle in place',
    async (operationName) => {
      await POST(copilotPost(operationName));

      expect(mockClearAgentImportFile).not.toHaveBeenCalled();
      expect(importFilePassedToGateway()).toBeUndefined();
      expect(mockImportFileRaw).not.toBeNull();
    },
  );

  it('the /info GET handshake leaves the handle in place', async () => {
    await GET(infoGet());

    expect(mockClearAgentImportFile).not.toHaveBeenCalled();
    expect(importFilePassedToGateway()).toBeUndefined();
    expect(mockImportFileRaw).not.toBeNull();
  });

  it('upload → handshake → turn: the turn still receives the staged file', async () => {
    await POST(copilotPost('availableAgents'));
    await POST(copilotPost('generateCopilotResponse'));

    expect(importFilePassedToGateway()).toEqual({
      handle: 'staged-handle',
      filename: 'movies.xlsx',
    });
    expect(mockClearAgentImportFile).toHaveBeenCalledTimes(1);
  });

  it('a billable turn consumes it exactly once — the next turn gets nothing', async () => {
    await POST(copilotPost('generateCopilotResponse'));
    expect(importFilePassedToGateway()).toEqual({
      handle: 'staged-handle',
      filename: 'movies.xlsx',
    });

    await POST(copilotPost('generateCopilotResponse'));
    expect(importFilePassedToGateway()).toBeUndefined();
    expect(mockClearAgentImportFile).toHaveBeenCalledTimes(1);
  });

  it('an unparseable body is billable (default-deny), so a malformed turn still gets its file', async () => {
    const req = {
      headers: { entries: () => Object.entries({})[Symbol.iterator]() },
      clone: () => ({ text: async () => 'not json' }),
    } as unknown as Request;

    await POST(req);

    expect(importFilePassedToGateway()).toEqual({
      handle: 'staged-handle',
      filename: 'movies.xlsx',
    });
  });
});

describe('agent /run — the UI snapshot resolves on the same condition as the import file', () => {
  beforeEach(() => {
    mockUiSnapshotRaw = JSON.stringify({ screen: 'collections' });
  });

  it('a handshake POST does not resolve the snapshot', async () => {
    await POST(copilotPost('availableAgents'));

    expect(lastGatewayOptions()?.uiSnapshot).toBeUndefined();
  });

  it('a billable turn resolves the snapshot', async () => {
    await POST(copilotPost('generateCopilotResponse'));

    expect(lastGatewayOptions()?.uiSnapshot).toEqual({ screen: 'collections' });
  });
});
