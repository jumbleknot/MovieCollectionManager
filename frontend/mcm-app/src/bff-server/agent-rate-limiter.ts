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
 * CopilotKit GraphQL handshake READS that run no model and therefore cost nothing: `availableAgents`
 * (the runtime-info fetch the dock issues on open), `loadAgentState`, and `hello` (health). The only
 * billable operation is the LLM run `generateCopilotResponse`.
 */
const NON_BILLABLE_AGENT_OPS: ReadonlySet<string> = new Set([
  'availableAgents',
  'loadAgentState',
  'hello',
]);

/**
 * Classify a CopilotKit runtime POST body as a billable LLM run (true) or a non-billable handshake
 * read (false) by its GraphQL `operationName` — the SAME signal the runtime dispatches on, so the
 * classification matches what actually executes.
 *
 * Security: DEFAULT-DENY. Only a body that POSITIVELY names a known non-LLM read is non-billable;
 * a missing, spoofed, non-string, or unparseable `operationName` is treated as billable so the cost
 * ceiling can never be dodged. (Labelling a run "availableAgents" cannot smuggle a turn — the
 * runtime would then execute the metadata resolver, not the model.) The cross-user thread-ownership
 * guard and rate limit are applied independently to EVERY POST and are not affected by this.
 */
export function isBillableAgentRun(body: string): boolean {
  let op: unknown;
  try {
    op = (JSON.parse(body) as { operationName?: unknown } | null)?.operationName;
  } catch {
    return true; // unparseable → treat as billable
  }
  return !(typeof op === 'string' && NON_BILLABLE_AGENT_OPS.has(op));
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
 */
export async function enforceAgentCostCeiling(userId: string): Promise<void> {
  const ceilingMicros = Math.round(env.agentSessionCostCeilingUsd * USD_TO_MICROS);
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
