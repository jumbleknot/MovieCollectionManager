/**
 * T050 — agent-config E2E seeding helper (feature 018).
 *
 * Feature 018 makes the movie assistant opt-in + bring-your-own-credentials, and the dock is
 * gated on a runnable per-user config (T018). The existing 012/014 assistant web E2E specs assume
 * the dock renders, so the shared E2E test user must have a runnable `user_agent_config` row seeded
 * before those specs run. This helper seeds it through the live BFF `PUT /bff-api/agent/config`
 * (the real validate-on-save path: probes Ollama + TMDB, encrypts, upserts) so the seed is
 * indistinguishable from a real user configuring the assistant — no shared-credential backdoor
 * (SC-002). The TMDB key comes from the harness env, never a committed value (NFR-Sec-1).
 *
 * Used by:
 *   - global-setup.ts — seed once before the suite (configured = default state).
 *   - assistant-config.spec.ts — the off/new-user case (T014) clears then re-seeds around itself.
 *
 * Both the dev-container BFF (which runs the probe) and the containerized gateway (which runs the
 * model) reach host Ollama at host.docker.internal:11434, so the SAME stored ollamaBaseUrl is valid
 * on both sides. Override with E2E_AGENT_OLLAMA_URL if your topology differs.
 */

import type { APIRequestContext } from '@playwright/test';

/** Provider base URL reachable from BOTH the BFF probe and the gateway model call (containers). */
export const SEED_OLLAMA_URL =
  process.env['E2E_AGENT_OLLAMA_URL'] ?? 'http://host.docker.internal:11434';

/** The TMDB key the seed stores as the user's own key. Sourced from the harness env (CI secret). */
export const SEED_TMDB_KEY = process.env['TMDB_API_KEY'] ?? '';

/**
 * True when the harness is configured to run the agent flows against the live gateway AND a TMDB
 * key is available to seed. The assistant suite (and its config seeding) only makes sense then.
 */
export function agentSeedingEnabled(): boolean {
  return process.env['E2E_AGENT_PRODUCTION'] === '1' && SEED_TMDB_KEY !== '';
}

/**
 * Seed (or refresh) the test user's runnable agent config via the real PUT path. Idempotent:
 * a later PUT that omits the secret keeps the stored TMDB key (FR-014), but we always send it so a
 * cleared/rotated state re-converges. Throws on a non-2xx so a broken seed fails the suite loudly
 * rather than letting every assistant spec mis-report "no dock".
 */
export async function seedAgentConfig(
  api: APIRequestContext,
  opts: { costLimitUsd?: number | null } = {},
): Promise<void> {
  const res = await api.put('/bff-api/agent/config', {
    data: {
      enabled: true,
      provider: 'ollama',
      ollamaBaseUrl: SEED_OLLAMA_URL,
      tmdbKey: SEED_TMDB_KEY,
      // US5: optionally seed a personal cost ceiling (omitted → global default governs).
      ...(opts.costLimitUsd !== undefined ? { costLimitUsd: opts.costLimitUsd } : {}),
    },
  });
  if (!res.ok()) {
    throw new Error(
      `[agent-config-seed] PUT /bff-api/agent/config failed: ${res.status()} ${await res.text()} ` +
        `(is host Ollama serving at ${SEED_OLLAMA_URL} from the BFF container, and TMDB reachable?)`,
    );
  }
}

/** Clear the test user's agent config (disable + wipe secrets) via the real DELETE path. */
export async function clearAgentConfig(api: APIRequestContext): Promise<void> {
  const res = await api.delete('/bff-api/agent/config');
  if (!res.ok() && res.status() !== 404) {
    throw new Error(
      `[agent-config-seed] DELETE /bff-api/agent/config failed: ${res.status()} ${await res.text()}`,
    );
  }
}
