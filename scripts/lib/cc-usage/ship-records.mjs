// Upsert shipping to the usage store for feature 105 (contracts/store-http.md "Writes"; FR-008).
//
// Every write is `POST /<table>?on_conflict=<natural key>` with
// `Prefer: resolution=merge-duplicates,return=minimal`, so re-sending is harmless. Parents go first
// (FK). Every table's rows pass through the privacy allowlist (privacy-shape.mjs) right here, so no
// caller can bypass it. A failure anywhere spools the WHOLE batch (replay is safe because every
// write upserts) and writes back-off; the token never reaches a log line or a returned reason.
import { log, spoolWrite, writeBackoff } from './local-state.mjs';
import { recordStoreRejection } from './obtain-access-token.mjs';
import { shapeRecords, shapeRows } from './privacy-shape.mjs';
import { timedFetch } from './timed-fetch.mjs';

export const TABLE_ORDER = ['sessions', 'features', 'turns', 'model_calls', 'tool_use', 'skill_use'];
export const ON_CONFLICT = {
  sessions: 'session_id',
  features: 'feature_id',
  turns: 'session_id,turn_seq',
  model_calls: 'session_id,message_id',
  tool_use: 'session_id,turn_seq,tool,command_family',
  skill_use: 'session_id,skill',
};
export const BATCH_CAPS = { sessions: 1, features: 50, turns: 500, model_calls: 500, tool_use: 500, skill_use: 100 };

class ShipError extends Error {}

/**
 * Send already-shaped per-table batches.
 * @param {Record<string, object[]>} batches
 * @param {{configDir: string, ingestUrl: string, fetch?: Function, getToken: () => Promise<string>,
 *          sessionId: string, range?: object, now?: number, spoolOnFailure?: boolean}} opts
 * @returns {Promise<{ok: boolean, spooled: boolean, reason?: string}>}
 */
/** Rows grouped by their key set, in first-seen order. */
function byKeySet(rows) {
  const groups = new Map();
  for (const r of rows) {
    const k = Object.keys(r).sort().join(',');
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  return [...groups.values()];
}

/**
 * One row per `on_conflict` key, first occurrence wins. Postgres refuses an upsert that touches one
 * row twice in a statement (SQLSTATE 21000), which PostgREST returns as a 500. This also lets a batch
 * spooled before the session-wide dedup (T077) replay.
 */
function uniqueByConflictKey(table, rows) {
  const cols = ON_CONFLICT[table].split(',');
  const seen = new Set();
  return rows.filter((row) => {
    const k = JSON.stringify(cols.map((c) => row[c] ?? null));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export async function sendBatches(batches, { configDir, ingestUrl, fetch = globalThis.fetch, getToken, sessionId, range = null, now = Date.now(), spoolOnFailure = true }) {
  const shaped = {};
  for (const t of TABLE_ORDER) if (batches[t]?.length) shaped[t] = uniqueByConflictKey(t, shapeRows(t, batches[t]));
  try {
    let token;
    try {
      token = await getToken();
    } catch (e) {
      throw new ShipError(e?.kind === 'rejected' ? 'client credential rejected' : 'token unavailable');
    }
    const base = String(ingestUrl).replace(/\/+$/, '');
    for (const table of TABLE_ORDER) {
      if (!shaped[table]) continue;
      // PostgREST requires every object of a bulk insert to have the same keys (PGRST102 → 400), and
      // filling a gap with null would overwrite a column on update. So rows go in groups of one key set.
      const chunks = [];
      for (const group of byKeySet(shaped[table])) {
        for (let i = 0; i < group.length; i += BATCH_CAPS[table]) chunks.push(group.slice(i, i + BATCH_CAPS[table]));
      }
      for (const chunk of chunks) {
        let res;
        try {
          res = await timedFetch(fetch, `${base}/${table}?on_conflict=${ON_CONFLICT[table]}`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              prefer: 'resolution=merge-duplicates,return=minimal',
            },
            body: JSON.stringify(chunk),
          });
        } catch {
          throw new ShipError('store unreachable');
        }
        if (res.status === 401) {
          recordStoreRejection(configDir, now);
          throw new ShipError('store rejects token');
        }
        if (!res.ok) throw new ShipError(`store ${res.status}`);
      }
    }
    log(configDir, { msg: 'shipped', session_id: sessionId, tables: Object.fromEntries(Object.entries(shaped).map(([k, v]) => [k, v.length])) }, { now });
    return { ok: true, spooled: false };
  } catch (e) {
    const reason = e instanceof ShipError ? e.message : 'ship failed';
    writeBackoff(configDir, now);
    let spooled = false;
    if (spoolOnFailure) spooled = spoolWrite(configDir, { sessionId, range, batches: shaped }, { configured: true, now });
    log(configDir, { level: 'warn', msg: 'ship failed', session_id: sessionId, reason, spooled }, { now });
    return { ok: false, spooled, reason };
  }
}

/** Parser records → shaped batches → store. */
export async function shipRecords(records, opts) {
  return sendBatches(shapeRecords(records), opts);
}
