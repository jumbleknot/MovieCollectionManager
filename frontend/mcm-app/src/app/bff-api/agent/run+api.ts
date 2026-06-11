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
 * T023/T025: the gateway URL is resolved by `agent-gateway-client` (mode-aware) and,
 * when token exchange is configured, the BFF mints a run-scoped RFC 8693 subject token
 * (`agent-subject-token`) and attaches it to the AG-UI `HttpAgent` so backend tool calls
 * (US1) carry the user's downscoped identity. The current supervisor graph is tool-free,
 * so a mint failure is non-fatal here — logged and the run proceeds without a token;
 * once US1 tools land, the backend calls will require it.
 */

import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from '@copilotkit/runtime';

import { requireAuth, extractRawToken } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { withRequestContext } from '@/bff-server/request-context';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { createMovieAssistantAgent } from '@/bff-server/agent-gateway-client';
import { mintSubjectToken, isSubjectTokenExchangeConfigured } from '@/bff-server/agent-subject-token';
import {
  checkAgentRequestRateLimit,
  enforceAgentCostCeiling,
  recordEstimatedTurnCost,
} from '@/bff-server/agent-rate-limiter';
import { enforceAgentThreadOwnership } from '@/bff-server/agent-thread-owner';
import { extractApprovalDecision, extractThreadId } from '@/bff-server/agent-resume';
import { getAgentUiSnapshot } from '@/bff-server/cache-service';
import { logger } from '@/bff-server/logger';
import { audit } from '@/bff-server/audit-sink';

const ENDPOINT = '/bff-api/agent/run';

/**
 * Best-effort mint of the run-scoped subject token. Returns undefined when token
 * exchange is unconfigured, no user token is present, or the exchange fails — the
 * tool-free graph still runs. The minted token is never logged or checkpointed (SC-004).
 */
async function resolveSubjectToken(
  headers: Record<string, string | string[] | undefined>,
): Promise<string | undefined> {
  if (!isSubjectTokenExchangeConfigured()) return undefined;
  const userToken = extractRawToken(headers);
  if (!userToken) return undefined;
  try {
    const { token } = await mintSubjectToken(userToken);
    return token;
  } catch {
    // Non-fatal for the tool-free graph; US1 tool calls will surface a hard failure.
    logger.warn('Proceeding without agent subject token', { action: 'agent_run' });
    return undefined;
  }
}

/**
 * Read the per-user sanitized UI snapshot cached by /ui-state (US3/R15) and parse it for the
 * `X-UI-Snapshot` header. Returns undefined when none is cached or the value is corrupt — the
 * run proceeds without it and the assistant clarifies a "this" reference rather than guessing.
 */
async function resolveUiSnapshot(userId: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await getAgentUiSnapshot(userId);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function gated(req: Request, enforceLimits: boolean): Promise<Response> {
  try {
    const headers = Object.fromEntries(req.headers.entries());
    const { user } = await requireAuth(headers);
    requireMcUser(user);

    // Per-user request rate limit + per-user/session cost ceiling (T027, FR-020a /
    // SC-011). Enforced only for an actual agent turn (POST), not the runtime /info
    // GET probe. A breach throws RateLimitError → 429 with a friendly message and no
    // run is started (no action). The per-agent gateway limit is T027a.
    if (enforceLimits) {
      await checkAgentRequestRateLimit(user.id);
      await enforceAgentCostCeiling(user.id);

      // Read the POST body once (cloned) for thread-ownership binding + the SC-002 audit.
      let bodyText = '';
      try {
        bodyText = await req.clone().text();
      } catch {
        /* unreadable body → undefined threadId + null audit (nothing to bind/record) */
      }

      // Bind the client-supplied thread to its owner BEFORE any gateway call. A cross-user
      // thread_id throws ForbiddenError → 403 and no run starts (cross-user resume guard,
      // implementation-review 2026-06-09). First use claims the thread for this user.
      await enforceAgentThreadOwnership(user.id, extractThreadId(bodyText));

      // SC-002 approval audit: CopilotKit's useInterrupt resumes through THIS /run endpoint (not
      // /resume), forwarding the decision in the body. Record an ApprovalDecision before the run
      // applies any write. Best-effort (never throws) — the audit must not block.
      try {
        const approval = extractApprovalDecision(bodyText);
        if (approval) {
          audit('approval_decision', {
            userId: user.id,
            threadId: approval.threadId,
            proposalId: approval.proposalId,
            decision: approval.decision,
          });
        }
      } catch {
        /* best-effort audit — never block the run */
      }

      // Accrue the per-turn cost estimate so the session cost ceiling actually trips (SC-011 —
      // the real LangFuse figure is observability-gated; this fixed estimate bounds spend in the
      // default config). The pre-flight ceiling check above already guaranteed "no action" on a
      // prior breach; this counts the turn now starting so the NEXT turn sees it.
      await recordEstimatedTurnCost(user.id);
    }

    const subjectToken = await resolveSubjectToken(headers);
    // US3/R15: bridge the cached sanitized UI snapshot to the gateway (POST turns only — the
    // /info GET handshake runs no graph). Resolves "this"/current-screen references.
    const uiSnapshot = enforceLimits ? await resolveUiSnapshot(user.id) : undefined;
    const runtime = new CopilotRuntime({
      agents: {
        movie_assistant: createMovieAssistantAgent({ subjectToken, uiSnapshot }),
      },
    });

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
  return withRequestContext(() => gated(req, true));
}

export async function GET(req: Request): Promise<Response> {
  // The CopilotKit client issues a GET for runtime /info; gate it like the run POST
  // (auth only — the /info probe is a handshake, not a billable agent turn).
  return withRequestContext(() => gated(req, false));
}
