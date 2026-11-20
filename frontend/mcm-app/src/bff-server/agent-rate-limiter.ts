/**
 * Agent assistant rate / cost limiter (T027).
 *
 * Provenance: FR-020a — the assistant MUST enforce a per-user request rate limit
 * AND a per-user/session cost ceiling; on breach it MUST return a friendly
 * "try again later" response and perform NO action (never unbounded spend). SC-011.
 *
 * Mirrors the existing `rate-limiter.ts` Redis-counter mechanism (plan.md: "reuse
 * the existing Redis rate-limiter"). Thresholds (plan.md): 20 requests / 60 s per
 * user; $0.50 / session cost ceiling, measured from LangFuse per-turn cost (T030).
 *
 * Cost is tracked in integer micro-USD so the integer `incr`/`expire`-on-first
 * fixed-window pattern from `cache-service` applies cleanly; the budget resets once
 * the window elapses rather than rolling forward forever.
 *
 * The per-AGENT (gateway-side) limit required by the constitution is enforced
 * separately in the gateway (T027a); this module covers the per-user BFF limits.
 */

import {
  incrementRateLimit,
  getAgentCostMicros,
  addAgentCostMicros,
} from '@/bff-server/cache-service';
import { logger } from '@/bff-server/logger';
import { env } from '@/config/env';
import { RateLimitError } from '@/types/errors';

const REQUEST_ENDPOINT = 'agent-run';
const USD_TO_MICROS = 1_000_000;

/**
 * CopilotKit single-endpoint methods that run NO model and therefore cost nothing (item #806).
 *
 * The client runs CopilotKit with `useSingleEndpoint`, so every POST is a `{ method, params?, body? }`
 * envelope, and the BFF mounts the runtime's single-route handler, which dispatches on that same
 * `method` (`@copilotkit/runtime` `dispatchRoute`). Shapes as @copilotkit/core 1.87.1 builds them:
 *
 *   info                — runtime info, fetched when the dock opens
 *   agent/connect       — reconnect to a thread; the runtime replays stored events (`runner.connect`)
 *   agent/stop          — stop a run
 *   trajectory/connect, resource/request, inspector/metadata — session, thread-resource and
 *                         inspector reads
 *
 * `agent/run` and `agent/suggest` run the model and are billable, as is anything not listed here.
 * The GraphQL `operationName` this used to key on (`availableAgents`, `loadAgentState`, `hello`) is
 * never sent any more and the runtime serves no GraphQL, so that branch is gone.
 */
const NON_BILLABLE_AGENT_METHODS: ReadonlySet<string> = new Set([
  'info',
  'agent/connect',
  'agent/stop',
  'trajectory/connect',
  'resource/request',
  'inspector/metadata',
]);

/**
 * Classify a CopilotKit runtime POST body as a billable model run (true) or a non-billable
 * handshake (false) by its envelope `method` — the SAME signal the runtime dispatches on, so the
 * classification matches what actually executes.
 *
 * Security: DEFAULT-DENY. Only a body that POSITIVELY names a known no-model method (exact match) is
 * non-billable; a missing, unknown, differently cased or non-string `method`, a non-object body, or
 * unparseable JSON is billable, so the cost ceiling can never be dodged. Labelling a run `info`
 * cannot smuggle a turn — the runtime would then execute `info`, not the model. The cross-user
 * thread-ownership guard and rate limit are applied independently to EVERY POST.
 */
export function isBillableAgentRun(body: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return true; // unparseable → billable
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return true;
  const method = (parsed as { method?: unknown }).method;
  return !(typeof method === 'string' && NON_BILLABLE_AGENT_METHODS.has(method));
}

/** Window over which the per-user/session cost budget accrues, in seconds. */
function costWindowSeconds(): number {
  return Math.max(1, Math.ceil(env.sessionAbsoluteTimeoutMs / 1000));
}

/**
 * Enforce the per-user request rate limit (FR-020a). Identifier: the Keycloak user
 * id. Throws RateLimitError (429) on breach so the caller returns "try again later"
 * and performs no action.
 */
export async function checkAgentRequestRateLimit(userId: string): Promise<void> {
  const windowSeconds = Math.max(1, Math.ceil(env.agentRateLimitWindowMs / 1000));
  const count = await incrementRateLimit(REQUEST_ENDPOINT, userId, windowSeconds);
  if (count > env.agentRateLimitRequests) {
    logger.audit('agent_rate_limit_exceeded', { userId, requestCount: count });
    throw new RateLimitError(windowSeconds);
  }
}

/**
 * Pre-flight cost ceiling check (FR-020a / SC-011). Throws RateLimitError BEFORE any
 * work when the accrued session cost has already reached the ceiling — guaranteeing
 * "no action" on breach. Each billable turn accrues its cost via `recordEstimatedTurnCost`
 * (a configured estimate; swap to `recordAgentCost` with the real figure once the gateway
 * pipes the LangFuse per-turn cost back to the BFF).
 *
 * `ceilingOverrideUsd` (US5, FR per-user spend cap): when a runnable config carries a
 * personal `costLimitUsd`, it OVERRIDES the global default for this user; an unset override
 * (undefined) falls back to `env.agentSessionCostCeilingUsd` — unchanged behavior (SC-005).
 * The accrual key (`agent-cost:{userId}`) is unaffected by the override.
 */
export async function enforceAgentCostCeiling(
  userId: string,
  ceilingOverrideUsd?: number,
): Promise<void> {
  const ceilingUsd =
    ceilingOverrideUsd != null && ceilingOverrideUsd > 0
      ? ceilingOverrideUsd
      : env.agentSessionCostCeilingUsd;
  const ceilingMicros = Math.round(ceilingUsd * USD_TO_MICROS);
  const totalMicros = await getAgentCostMicros(userId);
  if (totalMicros >= ceilingMicros) {
    logger.audit('agent_cost_ceiling_exceeded', { userId, accruedMicros: totalMicros });
    throw new RateLimitError(costWindowSeconds());
  }
}

/**
 * Accrue a turn's cost against the per-user/session budget. `costUsd` is the
 * LangFuse-measured per-turn cost (T030); non-positive values are ignored so an
 * unmeasured turn never corrupts the budget.
 */
export async function recordAgentCost(userId: string, costUsd: number): Promise<void> {
  if (!(costUsd > 0)) return;
  const micros = Math.round(costUsd * USD_TO_MICROS);
  await addAgentCostMicros(userId, micros, costWindowSeconds());
}

/**
 * Accrue the configured per-turn ESTIMATE against the session budget for one billable turn —
 * the production accrual that closes the SC-011 cost-ceiling loop (implementation-review
 * 2026-06-09). The real per-turn cost lives in the opt-in observability stack (LangFuse) and is
 * not available to the BFF in the default config, so `recordAgentCost` (real figure) never had
 * a caller and the ceiling could never trip. Accruing a fixed `AGENT_ESTIMATED_TURN_COST_USD`
 * per turn bounds session spend regardless of whether observability is enabled; when the real
 * per-turn figure is later piped from the gateway, call `recordAgentCost` with it instead.
 */
export async function recordEstimatedTurnCost(userId: string): Promise<void> {
  await recordAgentCost(userId, env.agentEstimatedTurnCostUsd);
}
