// Keycloak client-credentials token for the usage store (feature 105; research R18;
// contracts/store-http.md "Token acquisition").
//
// The secret travels ONLY in the POST body (never argv, never the URL) and the token is cached in
// token.json (0600) until 60 s before it expires, so a hook almost never waits on Keycloak. Neither
// value is ever logged or put in an error message. Concurrent callers are safe: each writes the
// whole cache file by temp-and-rename, and any valid token is as good as another.
import { rmSync } from 'node:fs';
import { backoffActive, log, paths, readJson, writeAtomic, writeBackoff } from './local-state.mjs';
import { timedFetch } from './timed-fetch.mjs';

export const CLIENT_ID = 'dev-usage-capture';
export const REFRESH_MARGIN_MS = 60_000;

export class TokenError extends Error {
  /** @param {'rejected'|'network'|'bad-response'} kind */
  constructor(kind, message) {
    super(message);
    this.name = 'TokenError';
    this.kind = kind;
  }
}

function writeTokenState(configDir, state, now) {
  writeAtomic(paths(configDir).tokenState, JSON.stringify({ state, at: now }));
}

/** @returns {Promise<{token: string, expiresAt: number}>} */
export async function obtainAccessToken({ configDir, tokenUrl, clientSecret, fetch = globalThis.fetch, now = Date.now() }) {
  const p = paths(configDir);
  const cached = readJson(p.token, null);
  if (cached?.access_token && Number.isFinite(cached.expires_at) && now < cached.expires_at - REFRESH_MARGIN_MS) {
    return { token: cached.access_token, expiresAt: cached.expires_at };
  }
  if (backoffActive(configDir, { now })) throw new TokenError('network', 'token endpoint in back-off');

  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: clientSecret ?? '' });
  let res;
  try {
    res = await timedFetch(fetch, tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
  } catch (e) {
    writeBackoff(configDir, now);
    log(configDir, { level: 'warn', msg: 'token endpoint unreachable', error: e?.name ?? 'Error' }, { now });
    throw new TokenError('network', 'token endpoint unreachable');
  }
  if (res.status === 400 || res.status === 401) {
    rmSync(p.token, { force: true });
    writeTokenState(configDir, 'rejected', now);
    log(configDir, { level: 'error', msg: 'client credential rejected', status: res.status }, { now });
    throw new TokenError('rejected', `client credential rejected (${res.status})`);
  }
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch { /* handled below */ }
  if (!res.ok || typeof json?.access_token !== 'string' || !Number.isFinite(json?.expires_in)) {
    writeBackoff(configDir, now);
    log(configDir, { level: 'warn', msg: 'token endpoint bad response', status: res.status }, { now });
    throw new TokenError('bad-response', `token endpoint answered ${res.status}`);
  }
  const expiresAt = now + json.expires_in * 1000;
  writeAtomic(p.token, JSON.stringify({ access_token: json.access_token, expires_at: expiresAt }), { mode: 0o600 });
  writeTokenState(configDir, 'valid', now);
  return { token: json.access_token, expiresAt };
}

/** The store answered 401 to a token we believe valid — likely a signing-key rotation (research R18). */
export function recordStoreRejection(configDir, now = Date.now()) {
  writeTokenState(configDir, 'store-rejects', now);
  log(configDir, { level: 'error', msg: 'store rejects token' }, { now });
}

/** For `doctor`: valid until …, client credential rejected, store rejects token, expired, or none. */
export function tokenState(configDir, { now = Date.now() } = {}) {
  const p = paths(configDir);
  const st = readJson(p.tokenState, null);
  if (st?.state === 'rejected') return { state: 'rejected', at: st.at };
  if (st?.state === 'store-rejects') return { state: 'store-rejects', at: st.at };
  const cached = readJson(p.token, null);
  if (!cached?.expires_at) return { state: 'none' };
  if (now >= cached.expires_at) return { state: 'expired', validUntil: cached.expires_at };
  return { state: 'valid', validUntil: cached.expires_at };
}
