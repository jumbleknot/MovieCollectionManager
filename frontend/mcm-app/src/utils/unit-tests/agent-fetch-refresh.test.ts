/**
 * Unit tests for the agent transport refresh-retry wrapper (feature 012).
 *
 * The CopilotKit runtime fetch to /bff-api/agent/run is NOT covered by the axios
 * token-refresh interceptor, so an expired access-token cookie 401s hard. This wrapper
 * refreshes once on an agent 401 and retries — mirroring utils/token-refresh for the
 * agent path. Tested with an injected baseFetch + refresh (no globals required).
 */
import { createRefreshingFetch } from '@/utils/agent-fetch-refresh';

type Resp = { status: number };

const resp = (status: number): Response => ({ status }) as unknown as Response;
const isAgentRequest = (u: string) => u.includes('/bff-api/agent/run');

describe('createRefreshingFetch', () => {
  it('passes a successful agent request through without refreshing', async () => {
    const refresh = jest.fn();
    const base = jest.fn().mockResolvedValue(resp(200));
    const f = createRefreshingFetch(base as never, { isAgentRequest, refresh });
    const r = (await f('/bff-api/agent/run')) as unknown as Resp;
    expect(r.status).toBe(200);
    expect(refresh).not.toHaveBeenCalled();
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('does not refresh non-agent 401s', async () => {
    const refresh = jest.fn();
    const base = jest.fn().mockResolvedValue(resp(401));
    const f = createRefreshingFetch(base as never, { isAgentRequest, refresh });
    const r = (await f('/bff-api/collections')) as unknown as Resp;
    expect(r.status).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('refreshes and retries once on an agent 401, returning the retry result', async () => {
    const refresh = jest.fn().mockResolvedValue(true);
    const base = jest
      .fn()
      .mockResolvedValueOnce(resp(401))
      .mockResolvedValueOnce(resp(200));
    const f = createRefreshingFetch(base as never, { isAgentRequest, refresh });
    const r = (await f('/bff-api/agent/run', { method: 'POST' })) as unknown as Resp;
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledTimes(2);
    expect(r.status).toBe(200);
  });

  it('returns the original 401 when refresh fails (no retry)', async () => {
    const refresh = jest.fn().mockResolvedValue(false);
    const base = jest.fn().mockResolvedValue(resp(401));
    const f = createRefreshingFetch(base as never, { isAgentRequest, refresh });
    const r = (await f('/bff-api/agent/run')) as unknown as Resp;
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(401);
  });

  it('retries at most once — still 401 after refresh returns 401, no loop', async () => {
    const refresh = jest.fn().mockResolvedValue(true);
    const base = jest.fn().mockResolvedValue(resp(401));
    const f = createRefreshingFetch(base as never, { isAgentRequest, refresh });
    const r = (await f('/bff-api/agent/run')) as unknown as Resp;
    expect(base).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(401);
  });

  it('resolves the URL from a Request-like object', async () => {
    const refresh = jest.fn().mockResolvedValue(true);
    const base = jest
      .fn()
      .mockResolvedValueOnce(resp(401))
      .mockResolvedValueOnce(resp(200));
    const f = createRefreshingFetch(base as never, { isAgentRequest, refresh });
    const r = (await f({ url: 'http://x/bff-api/agent/run' } as never)) as unknown as Resp;
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(200);
  });
});

/**
 * Transport-drop retry (feat agent-run-transport-retry).
 *
 * The /bff-api/agent/run stream can be LOST mid-flight — the adb-reverse tunnel resets and the
 * server's @expo/server respond pipeline throws `Cannot pipe to a closed or destroyed stream`
 * (CLAUDE.md). On the client this surfaces as a THROWN fetch error (RN's XHR streaming polyfill
 * rejects), so the run silently produces no `render_selection`/`render_disambiguation` tool call and
 * the dock panel never renders. A dropped connection aborts the upstream gateway turn via
 * @expo/server's AbortController, so the cut turn is effectively idempotent-on-failure → ONE bounded
 * retry is safe (mirrors the ui-action authorize() retry). A genuine 4xx comes back as a Response
 * (never a throw), so it is never retried; non-agent throws propagate unchanged.
 */
describe('createRefreshingFetch — transport-drop retry', () => {
  it('retries an agent request once when baseFetch throws, returning the retry result', async () => {
    const refresh = jest.fn();
    const base = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(resp(200));
    const f = createRefreshingFetch(base as never, { isAgentRequest, refresh, retryDelayMs: 0 });
    const r = (await f('/bff-api/agent/run', { method: 'POST' })) as unknown as Resp;
    expect(base).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled(); // a thrown transport error is not a 401 → no refresh
    expect(r.status).toBe(200);
  });

  it('does NOT retry a non-agent request that throws — propagates immediately', async () => {
    const refresh = jest.fn();
    const err = new TypeError('Network request failed');
    const base = jest.fn().mockRejectedValue(err);
    const f = createRefreshingFetch(base as never, { isAgentRequest, refresh, retryDelayMs: 0 });
    await expect(f('/bff-api/collections')).rejects.toBe(err);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it('propagates the error when both the initial call and the single retry throw (bounded, no loop)', async () => {
    const refresh = jest.fn();
    const err2 = new TypeError('still down');
    const base = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('down'))
      .mockRejectedValueOnce(err2);
    const f = createRefreshingFetch(base as never, { isAgentRequest, refresh, retryDelayMs: 0 });
    await expect(f('/bff-api/agent/run')).rejects.toBe(err2);
    expect(base).toHaveBeenCalledTimes(2);
  });

  it('never retries a genuine 4xx on the run path (a Response, not a throw)', async () => {
    const refresh = jest.fn();
    const base = jest.fn().mockResolvedValue(resp(403));
    const f = createRefreshingFetch(base as never, { isAgentRequest, refresh, retryDelayMs: 0 });
    const r = (await f('/bff-api/agent/run')) as unknown as Resp;
    expect(base).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(403);
  });
});
