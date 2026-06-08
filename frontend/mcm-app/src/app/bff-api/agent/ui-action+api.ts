/**
 * BFF /bff-api/agent/ui-action route (T059, US3) — UI-action authorization point.
 *
 * When the agent emits a UI-action tool call (`navigate_*` / `prefill_*`), the client asks the
 * BFF to authorize it BEFORE dispatching the navigation/prefill. This is the security-boundary
 * enforcement of the `ui-action-authorizer` (T026): default-deny against the user's JWT roles +
 * the structural-target allowlist, so the agent can never drive the UI somewhere the user could
 * not reach themselves (FR-011/FR-012, SC-003). The CopilotKit `/run` stream is an opaque
 * library bridge, so emission cannot be inspected mid-stream — the equivalent guarantee is
 * enforced here at dispatch: an unauthorized action is audited and discarded (403, no navigation).
 *
 * Body: `{ type: 'navigate' | 'prefill', target: string }` (structural keys only — no
 * collection/movie id, no values, no PII). Auth is enforced per-handler (requireAuth ->
 * requireMcUser), like every BFF route and the other agent routes (enumerated in the T028a
 * auth-guard regression).
 */

import { requireAuth } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { withRequestContext } from '@/bff-server/request-context';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { authorizeUiAction, type UiAction, type UiActionType } from '@/bff-server/ui-action-authorizer';
import { logger } from '@/bff-server/logger';

function parseAction(raw: unknown): UiAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const { type, target } = raw as { type?: unknown; target?: unknown };
  if ((type !== 'navigate' && type !== 'prefill') || typeof target !== 'string') return null;
  return { type: type as UiActionType, target };
}

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(async () => {
    try {
      const headers = Object.fromEntries(req.headers.entries());
      const { user } = await requireAuth(headers);
      requireMcUser(user);

      const action = parseAction(await req.json().catch(() => null));
      // A malformed action is itself an unauthorized request — default-deny (no navigation).
      const result = action
        ? authorizeUiAction(action, user)
        : { allowed: false, reason: 'malformed action' };

      // Audit every decision (no PII — structural target only): the agent driving the UI is a
      // security-relevant event, and a deny is the discard the contract requires.
      logger.audit('ui_action', {
        userId: user.id,
        type: action?.type ?? 'unknown',
        target: action?.target ?? 'unknown',
        allowed: result.allowed,
      });

      // 204 = authorized (client may navigate/prefill); 403 = denied + discarded.
      return new Response(null, { status: result.allowed ? 204 : 403 });
    } catch (err) {
      return handleMcApiError(err, 'agent_ui_action');
    }
  });
}
