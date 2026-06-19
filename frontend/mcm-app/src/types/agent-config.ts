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
