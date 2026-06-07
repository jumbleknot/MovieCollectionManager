/**
 * BFF /bff-api/agent/run route (T028 + T029) — CopilotKit runtime endpoint.
 *
 * The @copilotkit/react-native client speaks the CopilotKit runtime protocol (runtimeUrl),
 * so this route hosts the CopilotKit runtime (CopilotRuntime + an AG-UI `HttpAgent` →
 * the AG-UI-native gateway). The gateway exposes a native AG-UI endpoint (FastAPI +
 * ag_ui_langgraph), so the runtime binds it with the AG-UI `HttpAgent` from `@ag-ui/client`
 * — NOT `LangGraphHttpAgent`, which speaks the LangGraph Platform REST API (different
 * protocol) and 404s against the AG-UI endpoint. This is the framework's STANDARD library
 * bridge — not the bespoke per-event translation the constitution prohibits; the gateway
 * still emits AG-UI natively (research R6). The BFF remains the security boundary and sole
 * gateway caller.
 *
 * Auth is enforced per-handler BEFORE delegating to the runtime (401 UNAUTHORIZED /
 * 403 FORBIDDEN), consistent with every existing BFF route and proven by T028a.
 *
 * TODO(T023): mint a run-scoped RFC 8693 subject token and attach it to the AG-UI
 *   `HttpAgent` request headers, so backend tool calls (US1) carry the user's downscoped
 *   identity. Not required for the current tool-free supervisor graph.
 */

import { HttpAgent } from '@ag-ui/client';
import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from '@copilotkit/runtime';

import { requireAuth } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { withRequestContext } from '@/bff-server/request-context';
import { handleMcApiError } from '@/bff-server/mc-api-error';

const GATEWAY_URL = process.env.AGENT_GATEWAY_URL ?? 'http://localhost:8123';
const ENDPOINT = '/bff-api/agent/run';

const runtime = new CopilotRuntime({
  agents: {
    movie_assistant: new HttpAgent({ url: `${GATEWAY_URL}/agent/movie-assistant` }),
  },
});

async function gated(req: Request): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);

    const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
      runtime,
      serviceAdapter: new ExperimentalEmptyAdapter(),
      endpoint: ENDPOINT,
    });
    return handleRequest(req);
  } catch (err) {
    return handleMcApiError(err, 'agent_run');
  }
}

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(() => gated(req));
}

export async function GET(req: Request): Promise<Response> {
  // The CopilotKit client issues a GET for runtime /info; gate it like the run POST.
  return withRequestContext(() => gated(req));
}
