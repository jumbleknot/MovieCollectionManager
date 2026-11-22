// Feature 105 — reads and small writes to the store outside the batched upserts of ship-records.mjs:
// the interactive commands (US2+) and the feature bookkeeping (US3). Same token, same timeouts.
import { obtainAccessToken } from './obtain-access-token.mjs';
import { timedFetch } from './timed-fetch.mjs';

export class Unreachable extends Error {}

/** @param {{configured: boolean, configDir: string, tokenUrl: string, clientSecret: string, ingestUrl: string, fetch: Function, now: () => number}} cfg */
export function storeClient(cfg) {
  const call = async (method, path, body, prefer) => {
    if (!cfg.configured) throw new Unreachable('not configured');
    let res;
    try {
      const { token } = await obtainAccessToken({ configDir: cfg.configDir, tokenUrl: cfg.tokenUrl, clientSecret: cfg.clientSecret, fetch: cfg.fetch, now: cfg.now() });
      res = await timedFetch(cfg.fetch, `${String(cfg.ingestUrl).replace(/\/+$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(prefer ? { prefer } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new Unreachable('unreachable');
    }
    if (!res.ok) throw new Unreachable(`status ${res.status}`);
    if (method !== 'GET') return null;
    try { return JSON.parse(res.body); } catch { throw new Unreachable('unreadable'); }
  };
  return {
    get: (path) => call('GET', path),
    patch: (path, body) => call('PATCH', path, body, 'return=minimal'),
    upsert: (table, onConflict, rows) => call('POST', `/${table}?on_conflict=${onConflict}`, rows, 'resolution=merge-duplicates,return=minimal'),
  };
}
