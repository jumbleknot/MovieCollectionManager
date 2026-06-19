// Live credential probes for per-user agent config (feature 018, FR-012/FR-013, SC-008).
//
// One authenticated call per credential, each bounded by a 5s AbortController so a save never
// hangs. Outcomes are normalised to `'ok' | { reason }` — the raw provider response body is
// NEVER forwarded to the caller (Safe Error Responses), and the secret value is never echoed.
// These run server-side in the BFF only.

import type { ProbeStatus } from '@/types/agent-config';

export const PROBE_TIMEOUT_MS = 5000;

// Run a fetch with a hard timeout; map any network/abort failure to a safe reason. The caller
// passes a `label` used only to build a user-safe message — never any secret.
async function timedFetch(
  url: string,
  init: RequestInit,
  onResponse: (res: Response) => ProbeStatus | Promise<ProbeStatus>,
  unreachableReason: string,
): Promise<ProbeStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return await onResponse(res);
  } catch (err) {
    // Abort (timeout) or connection error — both are "couldn't reach / verify", never the raw error.
    const aborted = err instanceof Error && err.name === 'AbortError';
    return { reason: aborted ? 'Timed out after 5s — service unreachable' : unreachableReason };
  } finally {
    clearTimeout(timer);
  }
}

// Ollama: GET {baseUrl}/api/tags — 200 ⇒ reachable.
export async function probeOllama(baseUrl: string): Promise<ProbeStatus> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/tags`;
  return timedFetch(
    url,
    { method: 'GET' },
    (res) => (res.ok ? 'ok' : { reason: `Ollama responded ${res.status}` }),
    'Could not reach the Ollama server at that URL',
  );
}

// Anthropic: GET /v1/models with x-api-key — 200 ⇒ valid, 401 ⇒ invalid key. (No token spend.)
export async function probeAnthropic(key: string): Promise<ProbeStatus> {
  return timedFetch(
    'https://api.anthropic.com/v1/models',
    { method: 'GET', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
    (res) => {
      if (res.ok) return 'ok';
      if (res.status === 401 || res.status === 403) return { reason: 'Authentication failed (invalid key)' };
      return { reason: `Anthropic responded ${res.status}` };
    },
    'Could not reach the Anthropic API',
  );
}

// TMDB: GET /3/authentication with the v3 key — 200 ⇒ valid, 401 ⇒ invalid key.
export async function probeTmdb(key: string): Promise<ProbeStatus> {
  const url = `https://api.themoviedb.org/3/authentication?api_key=${encodeURIComponent(key)}`;
  return timedFetch(
    url,
    { method: 'GET' },
    (res) => {
      if (res.ok) return 'ok';
      if (res.status === 401 || res.status === 403) return { reason: 'Authentication failed (invalid key)' };
      return { reason: `TMDB responded ${res.status}` };
    },
    'Could not reach the TMDB API',
  );
}
