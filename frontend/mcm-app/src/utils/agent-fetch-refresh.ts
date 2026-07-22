/**
 * Agent transport refresh-retry wrapper (feature 012).
 *
 * Auth model: BFF cookies (constitution §Frontend App "Client Auth Model", Option A — web AND
 * native). The agent /run request is credentialed because CopilotKit's RN streaming-fetch polyfill
 * uses `XMLHttpRequest`, whose `withCredentials` defaults to `true` in React Native, so the native
 * cookie jar's `mcm_access_token` rides along automatically (the polyfill itself does NOT read
 * `init.credentials` — the cookie is carried by RN's default, NOT by an explicit flag; if a future
 * RN/CopilotKit upgrade flips that default, this breaks silently → the android-e2e harness must
 * regression-cover it).
 *
 * The CopilotKit runtime fetch to `/bff-api/agent/run` does NOT go through the axios token-refresh
 * interceptor (`utils/token-refresh`), so when the short-lived `mcm_access_token` cookie expires
 * (Keycloak access-token lifespan, ~5 min) the agent route 401s. The refresh-token cookie is
 * `Path=/bff-api/auth/refresh`, so the only lever is client-side: on a `/run` 401, call
 * `silentRefresh()` (axios → /auth/refresh → BFF re-sets the cookies in the shared RN cookie jar)
 * and retry the run once with the fresh cookie. (Whether this recovery fires correctly on a real
 * mid-session expiry — vs the failures seen under the unstable Windows-Metro harness — is the open
 * item the android-e2e workflow exists to confirm: see diagnosis-mobile-agent-no-token.md.)
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
  /** Delay before the single transport-drop retry (ms). Overridable for tests. Default below. */
  retryDelayMs?: number;
}

/** Settle time before the one transport-drop retry — lets a reset adb-reverse tunnel re-establish. */
export const RUN_RETRY_DELAY_MS = 250;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

    let res: Response;
    try {
      res = await baseFetch(input, init);
    } catch (err) {
      // A THROWN fetch error on the agent /run is a transient transport failure — the dropped
      // response stream / reset adb-reverse tunnel that surfaces server-side as `Cannot pipe to a
      // closed or destroyed stream` and rejects RN's XHR streaming polyfill client-side. Without
      // this, the run yields no render_selection/render_disambiguation tool call and the dock panel
      // never appears (feat agent-run-transport-retry). A dropped connection aborts the upstream
      // gateway turn via @expo/server's AbortController, so the cut turn is effectively
      // idempotent-on-failure → ONE bounded retry is safe (mirrors ui-action authorize()). Non-agent
      // throws propagate unchanged; a genuine 4xx returns a Response (never throws) so is never here.
      if (!isAgent) throw err;
      await delay(opts.retryDelayMs ?? RUN_RETRY_DELAY_MS);
      return baseFetch(retryInput, init);
    }
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
