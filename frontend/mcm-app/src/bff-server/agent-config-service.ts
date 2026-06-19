// Orchestration for per-user agent config (feature 018). Maps the stored document to the
// non-secret view, and (in later story phases) validates-on-save, tests stored credentials,
// and resolves per-run credentials. Plaintext secrets live only transiently here and are
// never returned to the client or logged (FR-018/020/022).

import * as store from '@/bff-server/agent-config-store';
import { decryptSecret, encryptSecret } from '@/bff-server/agent-config-crypto';
import { probeOllama, probeAnthropic, probeTmdb } from '@/bff-server/agent-config-probes';
import { env } from '@/config/env';
import type {
  AgentConfigUpdate,
  AgentConfigView,
  AgentProvider,
  ProbeError,
  ProbeStatus,
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

export type SaveResult =
  | { ok: true; view: AgentConfigView }
  | { ok: false; status: 400 | 422; errors: ProbeError[] };

const VALID_PROVIDERS: AgentProvider[] = ['ollama', 'anthropic'];

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function asProbeError(field: ProbeError['field'], status: ProbeStatus): ProbeError | null {
  return status === 'ok' ? null : { field, reason: status.reason };
}

// Validate-on-save (FR-012/013/014). Order: (1) shape/enum/type → 400; (2) missing required
// credential for an enable → 400; (3) live probes for every credential being set → 422; only
// on all-pass do we encrypt + upsert. A secret omitted from the body is never touched (FR-014).
export async function validateAndSave(
  userId: string,
  update: AgentConfigUpdate,
): Promise<SaveResult> {
  const existing = await store.getByUserId(userId);

  // (1) shape / enum / type
  const shape: ProbeError[] = [];
  if (update.provider !== undefined && !VALID_PROVIDERS.includes(update.provider)) {
    shape.push({ field: 'provider', reason: `Unknown provider "${update.provider}"` });
  }
  if (
    update.ollamaBaseUrl !== undefined &&
    update.ollamaBaseUrl !== null &&
    !isHttpUrl(update.ollamaBaseUrl)
  ) {
    shape.push({ field: 'ollamaBaseUrl', reason: 'Must be a valid http(s) URL' });
  }
  if (
    update.costLimitUsd !== undefined &&
    update.costLimitUsd !== null &&
    (!Number.isFinite(update.costLimitUsd) || update.costLimitUsd <= 0)
  ) {
    shape.push({ field: 'costLimitUsd', reason: 'Must be a positive number or null' });
  }
  if (update.anthropicKey !== undefined && update.anthropicKey.trim() === '') {
    shape.push({ field: 'anthropicKey', reason: 'Must not be empty' });
  }
  if (update.tmdbKey !== undefined && update.tmdbKey.trim() === '') {
    shape.push({ field: 'tmdbKey', reason: 'Must not be empty' });
  }
  if (shape.length) return { ok: false, status: 400, errors: shape };

  // Effective config after applying the patch over the stored doc.
  const provider: AgentProvider = update.provider ?? existing?.provider ?? 'ollama';
  const ollamaBaseUrl =
    update.ollamaBaseUrl !== undefined ? update.ollamaBaseUrl : existing?.ollamaBaseUrl ?? null;
  const enabled = update.enabled ?? existing?.enabled ?? false;
  const costLimitUsd =
    update.costLimitUsd !== undefined ? update.costLimitUsd : existing?.costLimitUsd ?? null;
  const willHaveAnthropic = update.anthropicKey !== undefined || Boolean(existing?.anthropicKeyEnc);
  const willHaveTmdb = update.tmdbKey !== undefined || Boolean(existing?.tmdbKeyEnc);

  // (2) enabling requires the runnability prerequisites to be present (provided or on file).
  if (enabled) {
    const missing: ProbeError[] = [];
    if (!willHaveTmdb) missing.push({ field: 'tmdbKey', reason: 'A TMDB key is required to enable the assistant' });
    if (provider === 'anthropic' && !willHaveAnthropic) {
      missing.push({ field: 'anthropicKey', reason: 'An Anthropic key is required for the Anthropic provider' });
    }
    if (provider === 'ollama' && !ollamaBaseUrl) {
      missing.push({ field: 'ollamaBaseUrl', reason: 'An Ollama base URL is required for the Ollama provider' });
    }
    if (missing.length) return { ok: false, status: 400, errors: missing };
  }

  // (3) live probes for every credential being set this request (≤5s each).
  const probes: Promise<ProbeError | null>[] = [];
  if (update.tmdbKey !== undefined) {
    probes.push(probeTmdb(update.tmdbKey).then((s) => asProbeError('tmdbKey', s)));
  }
  if (update.anthropicKey !== undefined) {
    probes.push(probeAnthropic(update.anthropicKey).then((s) => asProbeError('anthropicKey', s)));
  }
  if (update.ollamaBaseUrl !== undefined && update.ollamaBaseUrl !== null) {
    probes.push(probeOllama(update.ollamaBaseUrl).then((s) => asProbeError('ollamaBaseUrl', s)));
  }
  const probeErrors = (await Promise.all(probes)).filter((e): e is ProbeError => e !== null);
  if (probeErrors.length) return { ok: false, status: 422, errors: probeErrors };

  // (4) encrypt + upsert. Secrets omitted from the body are not touched (FR-014).
  const key = env.agentConfigEncKey;
  const patch: Partial<Omit<UserAgentConfigDoc, '_id'>> = {
    enabled,
    provider,
    ollamaBaseUrl,
    costLimitUsd,
  };
  if (update.anthropicKey !== undefined) patch.anthropicKeyEnc = encryptSecret(update.anthropicKey, key);
  if (update.tmdbKey !== undefined) patch.tmdbKeyEnc = encryptSecret(update.tmdbKey, key);

  const saved = await store.upsert(userId, patch);
  return { ok: true, view: toView(saved) };
}

export type TestResult =
  | { ok: true; results: Record<string, ProbeStatus> }
  | { ok: false; status: 409 };

// Re-probe the already-stored, server-decrypted credentials (US3, FR-013/015). No re-entry:
// secrets are decrypted transiently here and never returned to the client (FR-018). Each
// credential on file gets one ≤5s probe; a credential not on file is omitted from the result.
// When nothing is on file to test, returns a 409 (nothing-to-test) so the caller surfaces it.
export async function testStored(userId: string): Promise<TestResult> {
  const doc = await store.getByUserId(userId);
  if (!doc) return { ok: false, status: 409 };

  const key = env.agentConfigEncKey;
  const probes: Promise<[string, ProbeStatus]>[] = [];
  if (doc.ollamaBaseUrl) {
    probes.push(probeOllama(doc.ollamaBaseUrl).then((s) => ['ollama', s] as [string, ProbeStatus]));
  }
  if (doc.anthropicKeyEnc) {
    const plain = decryptSecret(doc.anthropicKeyEnc, key);
    probes.push(probeAnthropic(plain).then((s) => ['anthropic', s] as [string, ProbeStatus]));
  }
  if (doc.tmdbKeyEnc) {
    const plain = decryptSecret(doc.tmdbKeyEnc, key);
    probes.push(probeTmdb(plain).then((s) => ['tmdb', s] as [string, ProbeStatus]));
  }
  if (probes.length === 0) return { ok: false, status: 409 };

  const entries = await Promise.all(probes);
  return { ok: true, results: Object.fromEntries(entries) };
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
    costLimitUsd: doc.costLimitUsd ?? null,
  };
}
