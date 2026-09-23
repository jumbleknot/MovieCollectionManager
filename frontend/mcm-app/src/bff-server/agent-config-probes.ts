// Live credential probes for per-user agent config (feature 018, FR-012/FR-013, SC-008).
//
// One authenticated call per credential, each bounded by a 5s AbortController so a save never
// hangs. Outcomes are normalised to `'ok' | { reason }` — the raw provider response body is
// NEVER forwarded to the caller (Safe Error Responses), and the secret value is never echoed.
// These run server-side in the BFF only.

import * as http from 'node:http';
import * as https from 'node:https';

import type { ProbeStatus } from '@/types/agent-config';
import {
  assertOllamaUrlAllowed,
  OllamaUrlNotAllowedError,
  type OllamaLookup,
  type VettedOllamaTarget,
} from '@/bff-server/agent-config-ssrf';
import { createPinnedAgent } from '@/bff-server/pinned-agent';

export const PROBE_TIMEOUT_MS = 5000;

// A transient upstream 5xx (e.g. a TMDB 502 gateway blip) must not fail a credential save/probe —
// retry it a couple of times with a short linear backoff. Deterministic outcomes (2xx / 401 / 403 /
// other 4xx) and network/abort errors are NOT retried (an invalid key or an unreachable host is not
// transient). This hardens both validate-on-save and the E2E agent-config seed against provider blips.
export const PROBE_MAX_ATTEMPTS = 3;
export const PROBE_RETRY_BACKOFF_MS = 400;

// Run a fetch with a hard timeout; map any network/abort failure to a safe reason. `redirect:
// 'manual'` (review #3) stops a vetted URL from 30x-bouncing the BFF to a blocked internal target
// after the SSRF check — a redirect is treated as unverifiable, never followed. The raw error /
// URL is NEVER surfaced (it may carry a secret query param like TMDB's api_key — review #8).
async function timedFetch(
  url: string,
  init: RequestInit,
  onResponse: (res: Response) => ProbeStatus | Promise<ProbeStatus>,
  unreachableReason: string,
): Promise<ProbeStatus> {
  for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    } catch (err) {
      // Abort (timeout) or connection error — both are "couldn't reach / verify", never the raw error.
      const aborted = err instanceof Error && err.name === 'AbortError';
      return { reason: aborted ? 'Timed out after 5s — service unreachable' : unreachableReason };
    } finally {
      clearTimeout(timer);
    }
    // Retry only a transient upstream 5xx; everything else is returned to onResponse as-is.
    if (res.status >= 500 && res.status < 600 && attempt < PROBE_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_BACKOFF_MS * attempt));
      continue;
    }
    return await onResponse(res);
  }
  // Unreachable — the loop always returns on its final attempt; satisfies the type checker.
  return { reason: unreachableReason };
}

// Ollama: GET {baseUrl}/api/tags — 200 ⇒ reachable.
//
// The URL is re-checked here rather than trusted from save time (defence in depth, and the answer
// for a name can have changed since), and the connection is PINNED to the addresses that check
// returned. Item #542: the guard used to be DNS-blind and this probe used `fetch`, so a name that
// resolved into a blocked range was never caught and nothing stopped the resolver being asked a
// second time between the check and the connection.
//
// `http.request` also does not follow redirects AT ALL, which is strictly stronger than the
// `redirect: 'manual'` this used to rely on: there is no redirect-following code path to get wrong.
export async function probeOllama(
  baseUrl: string,
  opts: { lookup?: OllamaLookup } = {},
): Promise<ProbeStatus> {
  let vetted: VettedOllamaTarget;
  try {
    vetted = await assertOllamaUrlAllowed(baseUrl, opts);
  } catch (err) {
    if (err instanceof OllamaUrlNotAllowedError) return { reason: err.reason };
    return { reason: 'That Ollama URL is not allowed' };
  }
  const basePath = vetted.url.pathname.replace(/\/+$/, '');
  return timedPinnedGet(vetted, `${basePath}/api/tags`, (status) =>
    status >= 200 && status < 300 ? 'ok' : { reason: `Ollama responded ${status}` },
  );
}

/**
 * A GET over a pinned socket, with the same timeout and transient-5xx retry policy as
 * `timedFetch`. The response BODY is discarded — only the status is ever used, and a probe that
 * forwarded an upstream body would be the leak the "safe reason" rule exists to prevent.
 */
async function timedPinnedGet(
  vetted: VettedOllamaTarget,
  path: string,
  onStatus: (status: number) => ProbeStatus,
): Promise<ProbeStatus> {
  const unreachableReason = 'Could not reach the Ollama server at that URL';
  const client = vetted.protocol === 'https:' ? https : http;

  for (let attempt = 1; attempt <= PROBE_MAX_ATTEMPTS; attempt++) {
    let status: number;
    try {
      status = await new Promise<number>((resolve, reject) => {
        const req = client.request(
          {
            // The HOSTNAME, not the address: TLS SNI and certificate verification must see the
            // name the certificate was issued for. The pinned lookup is what sends the socket to
            // the vetted address.
            host: vetted.hostname,
            port: vetted.port,
            method: 'GET',
            path,
            agent: createPinnedAgent(vetted),
            timeout: PROBE_TIMEOUT_MS,
          },
          (res) => {
            res.resume(); // drain and discard; the body is never read
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('timeout', () => req.destroy(new ProbeTimeout()));
        req.on('error', reject);
        req.end();
      });
    } catch (err) {
      // Timeout or connection error — both are "couldn't reach / verify". The raw error is NEVER
      // surfaced: it can carry the resolved address and internal resolver detail.
      return {
        reason: err instanceof ProbeTimeout ? 'Timed out after 5s — service unreachable' : unreachableReason,
      };
    }
    if (status >= 500 && status < 600 && attempt < PROBE_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, PROBE_RETRY_BACKOFF_MS * attempt));
      continue;
    }
    return onStatus(status);
  }
  return { reason: unreachableReason };
}

class ProbeTimeout extends Error {}

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
