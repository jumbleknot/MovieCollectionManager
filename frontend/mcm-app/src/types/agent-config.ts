// Per-user movie-assistant configuration types (feature 018).
// See specs/018-per-user-agent-config/data-model.md.

export type AgentProvider = 'ollama' | 'anthropic';

// At-rest document shape in the user_agent_config collection. Secrets are stored
// only as AES-256-GCM blobs (*Enc); plaintext secrets are NEVER persisted.
export interface UserAgentConfigDoc {
  _id: string; // Keycloak userId
  enabled: boolean;
  provider: AgentProvider;
  ollamaBaseUrl: string | null;
  anthropicKeyEnc?: string;
  tmdbKeyEnc?: string;
  costLimitUsd: number | null;
  updatedAt: string; // ISO-8601 UTC
}

// Non-secret projection returned by GET /bff-api/agent/config (FR-018).
// Never includes any secret value — only presence flags.
export interface AgentConfigView {
  enabled: boolean;
  provider: AgentProvider;
  ollamaBaseUrl: string | null;
  hasAnthropicKey: boolean;
  hasTmdbKey: boolean;
  costLimitUsd: number | null;
  escalationAvailable: boolean; // derived: hasAnthropicKey
  updatedAt: string | null;
}

// The disabled/empty non-secret view — the single source of truth shared by the server
// (toView of a missing doc) and the client (pre-fetch default). Deduplicated here so a new
// AgentConfigView field can't go stale in one copy (018 review cleanup).
export const DISABLED_AGENT_CONFIG_VIEW: AgentConfigView = {
  enabled: false,
  provider: 'ollama',
  ollamaBaseUrl: null,
  hasAnthropicKey: false,
  hasTmdbKey: false,
  costLimitUsd: null,
  escalationAvailable: false,
  updatedAt: null,
};

// The FR-002 runnability rule, expressed over provider-agnostic facts so the SAME predicate
// governs the server-side /run gate (over the stored doc) and the client-side dock gate (over
// the non-secret view) — one rule, no divergence (018 review cleanup).
export interface RunnabilityFacts {
  enabled: boolean;
  provider: AgentProvider;
  hasTmdb: boolean;
  hasAnthropic: boolean;
  hasOllamaUrl: boolean;
}

export function isRunnableFrom(f: RunnabilityFacts): boolean {
  if (!f.enabled || !f.hasTmdb) return false;
  if (f.provider === 'anthropic') return f.hasAnthropic;
  if (f.provider === 'ollama') return f.hasOllamaUrl;
  return false;
}

// Runnability over the non-secret view (client dock gate + server view derivation).
export function isViewRunnable(v: AgentConfigView): boolean {
  return isRunnableFrom({
    enabled: v.enabled,
    provider: v.provider,
    hasTmdb: v.hasTmdbKey,
    hasAnthropic: v.hasAnthropicKey,
    hasOllamaUrl: Boolean(v.ollamaBaseUrl),
  });
}

// Request body for PUT /bff-api/agent/config. Secret fields omitted ⇒ keep stored (FR-014).
export interface AgentConfigUpdate {
  enabled?: boolean;
  provider?: AgentProvider;
  ollamaBaseUrl?: string | null;
  anthropicKey?: string;
  tmdbKey?: string;
  costLimitUsd?: number | null;
}

// In-memory, per-run resolved credentials (FR-020) — NEVER persisted, logged, or traced.
// `costLimitUsd` is a BFF-only field (per-user cost ceiling, US5) — it governs
// enforceAgentCostCeiling and is NOT serialized into the gateway X-Agent-Config payload.
export interface ResolvedRunConfig {
  provider: AgentProvider;
  ollamaBaseUrl: string | null;
  anthropicKey?: string;
  tmdbKey: string;
  costLimitUsd: number | null;
}

// The three probed credentials, plus the non-secret fields that can fail shape validation on
// save (so PUT 400 errors are attributable to the right form field).
export type ProbeField = 'ollamaBaseUrl' | 'anthropicKey' | 'tmdbKey' | 'provider' | 'costLimitUsd';

// Per-credential validation outcome — never carries the secret value (FR-013).
export type ProbeStatus = 'ok' | { reason: string };

export interface ProbeError {
  field: ProbeField;
  reason: string;
}
