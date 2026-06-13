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
 * On mobile (React Native) there is no HttpOnly BFF cookie — the access token lives in SecureStore
 * and every request authenticates via an `Authorization: Bearer <token>` header (mirroring the
 * axios `api-client` interceptor). CopilotKit's plain `fetch` to `/run` does NOT add that header,
 * so on mobile the agent route 401s with `no_token` even when the user is signed in. This wrapper
 * therefore ALSO injects the bearer token on agent requests (initial + post-refresh retry). On web
 * `getToken` resolves null (the token is in the cookie) and no header is added — the cookie path is
 * unchanged.
 *
 * `createRefreshingFetch` is a pure factory (inject baseFetch + refresh + getToken) so it is
 * unit-testable without any global. `installAgentFetchRefresh` wraps `globalThis.fetch` once,
 * before CopilotKit issues any run (called from `assistant-polyfills`, the first import).
 */
import { silentRefresh } from '@/utils/token-refresh';
import { getAccessToken } from '@/utils/session-storage';

type FetchLike = (input: unknown, init?: unknown) => Promise<Response>;

export interface RefreshingFetchOptions {
  /** True when the request targets the agent runtime route (the only path we refresh-retry). */
  isAgentRequest: (url: string) => boolean;
  /** Perform a silent token refresh; resolves true when new cookies/tokens were set. */
  refresh: () => Promise<boolean>;
  /**
   * Client-side access token for the `Authorization` header (mobile SecureStore). Resolves null on
   * web, where the session rides an HttpOnly cookie and no header is needed. Optional — when absent
   * or null, no header is injected (the request relies on cookies).
   */
  getToken?: () => Promise<string | null>;
}

function resolveUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof (input as { url?: unknown }).url === 'string') {
    return (input as { url: string }).url;
  }
  return '';
}

/**
 * Return an `init` carrying `Authorization: Bearer <token>` merged over any existing headers (from a
 * `Request` input and/or the supplied `init`). A null token leaves `init` untouched (web cookie path).
 */
function withBearer(input: unknown, init: unknown, token: string | null): unknown {
  if (!token) return init;
  const headers = new Headers();
  if (typeof Request !== 'undefined' && input instanceof Request) {
    input.headers.forEach((value, key) => headers.set(key, value));
  }
  const initHeaders = (init as RequestInit | undefined)?.headers;
  if (initHeaders) {
    new Headers(initHeaders).forEach((value, key) => headers.set(key, value));
  }
  headers.set('Authorization', `Bearer ${token}`);
  return { ...(init as object), headers };
}

/**
 * Wrap a fetch so an agent-route request carries the bearer token (mobile) and a 401 triggers a
 * single refresh + retry (with the refreshed token). Non-agent requests pass straight through —
 * neither token injection nor refresh-retry applies to them.
 */
export function createRefreshingFetch(
  baseFetch: FetchLike,
  opts: RefreshingFetchOptions,
): FetchLike {
  return async (input: unknown, init?: unknown): Promise<Response> => {
    if (!opts.isAgentRequest(resolveUrl(input))) return baseFetch(input, init);

    // Clone a Request up front so the retry has an unconsumed body (string bodies in `init`
    // are already reusable; only a Request carries a single-use body stream).
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const retryInput = isRequest ? (input as Request).clone() : input;

    const token = opts.getToken ? await opts.getToken() : null;
    const res = await baseFetch(input, withBearer(input, init, token));
    if (res.status !== 401) return res;

    const refreshed = await opts.refresh();
    if (!refreshed) return res;
    const newToken = opts.getToken ? await opts.getToken() : null;
    return baseFetch(retryInput, withBearer(retryInput, init, newToken));
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
    // Mobile: attach the SecureStore access token as a bearer header (web resolves null → cookie).
    getToken: getAccessToken,
  });
}
