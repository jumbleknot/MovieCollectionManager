/**
 * Agent transport refresh-retry wrapper (feature 012).
 *
 * The CopilotKit runtime fetch to `/bff-api/agent/run` does NOT go through the axios
 * token-refresh interceptor (`utils/token-refresh`), so when the short-lived
 * `mcm_access_token` cookie expires (Keycloak access-token lifespan, ~5 min) the agent
 * route 401s hard → `agent_run_failed`. The refresh-token cookie is `Path=/bff-api/auth/refresh`,
 * so the agent route can never self-refresh server-side — the only lever is client-side:
 * on a `/run` 401, call `silentRefresh()` (which re-sets the cookies) and retry the run once.
 *
 * `createRefreshingFetch` is a pure factory (inject baseFetch + refresh) so it is unit-testable
 * without any global. `installAgentFetchRefresh` wraps `globalThis.fetch` once, before CopilotKit
 * issues any run (called from `assistant-polyfills`, the first import).
 */
import { silentRefresh } from '@/utils/token-refresh';

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

export interface RefreshingFetchOptions {
  /** True when the request targets the agent runtime route (the only path we refresh-retry). */
  isAgentRequest: (url: string) => boolean;
  /** Perform a silent token refresh; resolves true when new cookies were set. */
  refresh: () => Promise<boolean>;
}

function resolveUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof (input as { url?: unknown }).url === 'string') {
    return (input as { url: string }).url;
  }
  return '';
}

/**
 * Wrap a fetch so an agent-route 401 triggers a single refresh + retry.
 * Non-agent requests and non-401 responses pass straight through.
 */
export function createRefreshingFetch(
  baseFetch: FetchLike,
  opts: RefreshingFetchOptions,
): FetchLike {
  return async (input: unknown, init?: unknown): Promise<Response> => {
    const isAgent = opts.isAgentRequest(resolveUrl(input));
    // Clone a Request up front so the retry has an unconsumed body (string bodies in `init`
    // are already reusable; only a Request carries a single-use body stream).
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const retryInput = isRequest ? (input as Request).clone() : input;

    const res = await baseFetch(input, init);
    if (!isAgent || res.status !== 401) return res;

    const refreshed = await opts.refresh();
    if (!refreshed) return res;
    return baseFetch(retryInput, init);
  };
}

let installed = false;

/**
 * Wrap `globalThis.fetch` with the agent refresh-retry behaviour, once. Idempotent and a no-op
 * where `fetch` is unavailable. The agent route is matched by path so all other fetches are
 * untouched. CopilotKit resolves `fetch` at call time, so installing before the first run suffices.
 */
export function installAgentFetchRefresh(): void {
  if (installed) return;
  const g = globalThis as { fetch?: FetchLike };
  if (typeof g.fetch !== 'function') return;
  installed = true;
  const base = g.fetch.bind(globalThis) as unknown as FetchLike;
  g.fetch = createRefreshingFetch(base, {
    isAgentRequest: (url) => url.includes('/bff-api/agent/run'),
    refresh: silentRefresh,
  });
}
