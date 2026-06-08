/**
 * BFF /bff-api/agent/ui-state route (T057, US3 / research R15).
 *
 * Standalone push of a sanitized readable UI-state snapshot so context-aware "this"
 * references resolve the current target ("add <movie> to this"). The client pushes the raw
 * structural snapshot (current screen + loaded collection/movie id + structural filter keys)
 * on screen focus and immediately before sending a turn.
 *
 * This route is the SOLE sanitization point: `sanitizeUiState` reduces the body to the
 * structural-field allowlist (drops all PII / user-entered values / unknown keys), then the
 * sanitized snapshot is cached per user. The next `/bff-api/agent/run` reads it and bridges it
 * to the gateway as the `X-UI-Snapshot` header → `config["configurable"]["ui_snapshot"]`
 * (mirrors the subject-token bridge; never the run body, never checkpointed state).
 *
 * Auth is enforced per-handler (requireAuth -> requireMcUser), like every BFF route and the
 * other agent routes — proven by the T028a auth-guard regression (this route is enumerated
 * there). No tokens, values, or PII are forwarded.
 */

import { requireAuth } from '@/bff-server/auth';
import { requireMcUser } from '@/bff-server/role-check';
import { withRequestContext } from '@/bff-server/request-context';
import { handleMcApiError } from '@/bff-server/mc-api-error';
import { sanitizeUiState } from '@/bff-server/ui-state-sanitizer';
import { setAgentUiSnapshot } from '@/bff-server/cache-service';

export async function POST(req: Request): Promise<Response> {
  return withRequestContext(async () => {
    try {
      const headers = Object.fromEntries(req.headers.entries());
      const { user } = await requireAuth(headers);
      requireMcUser(user);

      // Sole sanitization point: allowlist structural fields only (no PII/values).
      const raw = await req.json().catch(() => null);
      const sanitized = sanitizeUiState(raw);
      if (sanitized) {
        await setAgentUiSnapshot(user.id, JSON.stringify(sanitized));
      }

      // 204 even when the body sanitizes to nothing — this is a best-effort context push.
      return new Response(null, { status: 204 });
    } catch (err) {
      return handleMcApiError(err, 'agent_ui_state');
    }
  });
}
