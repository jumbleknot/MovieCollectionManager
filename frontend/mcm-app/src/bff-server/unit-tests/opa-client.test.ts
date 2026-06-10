/**
 * Unit tests for opa-client.ts
 *
 * Verifies:
 *   1. OPA_URL unset → {configured:false, allowed:true} and fetch NOT called
 *   2. OPA responds result:true → {configured:true, allowed:true}
 *   3. OPA responds non-2xx → {configured:true, allowed:false}
 *   4. fetch throws → {configured:true, allowed:false}
 */

jest.mock('@/bff-server/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    audit: jest.fn(),
  },
}));

// Keep a reference to the original fetch (if present)
const originalFetch = global.fetch;

describe('opaAllowsUiAction', () => {
  let mockFetch: jest.Mock;

  function loadModule() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@/bff-server/opa-client') as typeof import('@/bff-server/opa-client');
  }

  beforeEach(() => {
    // Reset module registry so env-variable changes take effect on re-require
    jest.resetModules();

    // Install a fresh mock fetch before each module load
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    delete process.env.OPA_URL;
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  // ─── OPA_URL unset ────────────────────────────────────────────────────────────

  it('returns {configured:false, allowed:true} and does NOT call fetch when OPA_URL is unset', async () => {
    delete process.env.OPA_URL;
    const { opaAllowsUiAction } = loadModule();

    const result = await opaAllowsUiAction({
      action_type: 'navigate',
      target: 'home',
      roles: ['mc-user'],
    });

    expect(result).toEqual({ configured: false, allowed: true });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('isOpaConfigured() returns false when OPA_URL is unset', () => {
    delete process.env.OPA_URL;
    const { isOpaConfigured } = loadModule();
    expect(isOpaConfigured()).toBe(false);
  });

  // ─── OPA returns result:true ──────────────────────────────────────────────────

  it('returns {configured:true, allowed:true} when OPA responds result:true', async () => {
    process.env.OPA_URL = 'http://localhost:8181';
    const { opaAllowsUiAction } = loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: true }),
    });

    const result = await opaAllowsUiAction({
      action_type: 'navigate',
      target: 'collection',
      roles: ['mc-user'],
    });

    expect(result).toEqual({ configured: true, allowed: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8181/v1/data/mcm/agent_ui_action/allow',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: { action_type: 'navigate', target: 'collection', roles: ['mc-user'] } }),
      }),
    );
  });

  it('isOpaConfigured() returns true when OPA_URL is set', () => {
    process.env.OPA_URL = 'http://localhost:8181';
    const { isOpaConfigured } = loadModule();
    expect(isOpaConfigured()).toBe(true);
  });

  it('returns {configured:true, allowed:false} when OPA responds result:false', async () => {
    process.env.OPA_URL = 'http://localhost:8181';
    const { opaAllowsUiAction } = loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: false }),
    });

    const result = await opaAllowsUiAction({
      action_type: 'navigate',
      target: 'collection',
      roles: [],
    });

    expect(result).toEqual({ configured: true, allowed: false });
  });

  // ─── OPA non-2xx ──────────────────────────────────────────────────────────────

  it('returns {configured:true, allowed:false} and error-logs when OPA responds non-2xx', async () => {
    process.env.OPA_URL = 'http://localhost:8181';
    const { opaAllowsUiAction } = loadModule();
    // Re-require logger to get the mock instance after resetModules
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { logger } = require('@/bff-server/logger') as typeof import('@/bff-server/logger');

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const result = await opaAllowsUiAction({
      action_type: 'navigate',
      target: 'collection',
      roles: ['mc-user'],
    });

    expect(result).toEqual({ configured: true, allowed: false });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('non-2xx'),
      expect.objectContaining({ action: 'opa_ui_action', status: 500 }),
    );
  });

  // ─── fetch throws ─────────────────────────────────────────────────────────────

  it('returns {configured:true, allowed:false} and error-logs when fetch throws', async () => {
    process.env.OPA_URL = 'http://localhost:8181';
    const { opaAllowsUiAction } = loadModule();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { logger } = require('@/bff-server/logger') as typeof import('@/bff-server/logger');

    const networkError = new Error('ECONNREFUSED');
    mockFetch.mockRejectedValueOnce(networkError);

    const result = await opaAllowsUiAction({
      action_type: 'prefill',
      target: 'add-movie',
      roles: ['mc-user'],
    });

    expect(result).toEqual({ configured: true, allowed: false });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      expect.objectContaining({ action: 'opa_ui_action', error: networkError }),
    );
  });

  // ─── Trailing slash stripped from OPA_URL ────────────────────────────────────

  it('strips trailing slash from OPA_URL before appending the path', async () => {
    process.env.OPA_URL = 'http://localhost:8181/';
    const { opaAllowsUiAction } = loadModule();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ result: true }),
    });

    await opaAllowsUiAction({ action_type: 'navigate', target: 'home', roles: ['mc-user'] });

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8181/v1/data/mcm/agent_ui_action/allow',
      expect.anything(),
    );
  });
});
