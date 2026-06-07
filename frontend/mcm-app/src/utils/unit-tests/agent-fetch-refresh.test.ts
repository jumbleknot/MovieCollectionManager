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
