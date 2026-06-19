// Orchestration for per-user agent config (feature 018). Maps the stored document to the
// non-secret view, and (in later story phases) validates-on-save, tests stored credentials,
// and resolves per-run credentials. Plaintext secrets live only transiently here and are
// never returned to the client or logged (FR-018/020/022).

import * as store from '@/bff-server/agent-config-store';
import { decryptSecret } from '@/bff-server/agent-config-crypto';
import { env } from '@/config/env';
import type {
  AgentConfigUpdate,
  AgentConfigView,
  ProbeError,
  ResolvedRunConfig,
  UserAgentConfigDoc,
} from '@/types/agent-config';

const DISABLED_DEFAULT: AgentConfigView = {
  enabled: false,
  provider: 'ollama',
  ollamaBaseUrl: null,
  hasAnthropicKey: false,
  hasTmdbKey: false,
  costLimitUsd: null,
  escalationAvailable: false,
  updatedAt: null,
};

function toView(doc: UserAgentConfigDoc | null): AgentConfigView {
  if (!doc) return { ...DISABLED_DEFAULT };
  const hasAnthropicKey = Boolean(doc.anthropicKeyEnc);
  return {
    enabled: doc.enabled,
    provider: doc.provider,
    ollamaBaseUrl: doc.ollamaBaseUrl ?? null,
    hasAnthropicKey,
    hasTmdbKey: Boolean(doc.tmdbKeyEnc),
    costLimitUsd: doc.costLimitUsd ?? null,
    escalationAvailable: hasAnthropicKey,
    updatedAt: doc.updatedAt ?? null,
  };
}

// Determine whether a stored config can actually run (FR-002): enabled + the chosen
// provider's required credential + a TMDB key (required to enable/run per clarification).
export function isRunnable(doc: UserAgentConfigDoc | null): doc is UserAgentConfigDoc {
  if (!doc || !doc.enabled || !doc.tmdbKeyEnc) return false;
  if (doc.provider === 'anthropic') return Boolean(doc.anthropicKeyEnc);
  if (doc.provider === 'ollama') return Boolean(doc.ollamaBaseUrl);
  return false;
}

export async function getNonSecretView(userId: string): Promise<AgentConfigView> {
  return toView(await store.getByUserId(userId));
}

export async function clear(userId: string): Promise<AgentConfigView> {
  await store.clear(userId);
  return getNonSecretView(userId);
}

// --- Filled in later story phases (US2 / US3) ---

export async function validateAndSave(
  _userId: string,
  _update: AgentConfigUpdate,
): Promise<{ ok: true; view: AgentConfigView } | { ok: false; errors: ProbeError[] }> {
  throw new Error('validateAndSave not yet implemented (T026)');
}

export async function testStored(
  _userId: string,
): Promise<Record<string, 'ok' | { reason: string }>> {
  throw new Error('testStored not yet implemented (T035)');
}

// Resolve per-run credentials in memory (US1 short-circuit + US2 injection). Returns null
// when the config is not runnable so the caller short-circuits before any gateway call.
// Decryption happens here, transiently — the returned plaintext is per-run only and must
// never be persisted, logged, or traced (FR-020/022).
export async function resolveForRun(userId: string): Promise<ResolvedRunConfig | null> {
  const doc = await store.getByUserId(userId);
  if (!isRunnable(doc)) return null;
  const key = env.agentConfigEncKey;
  return {
    provider: doc.provider,
    ollamaBaseUrl: doc.ollamaBaseUrl ?? null,
    anthropicKey: doc.anthropicKeyEnc ? decryptSecret(doc.anthropicKeyEnc, key) : undefined,
    tmdbKey: decryptSecret(doc.tmdbKeyEnc!, key),
  };
}
