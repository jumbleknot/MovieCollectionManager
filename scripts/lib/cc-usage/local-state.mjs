// Local state for feature 105, under $CLAUDE_CONFIG_DIR/usage/ on the persistent volume
// (data-model.md "Local state"). Never shipped.
//
// Concurrency rules (FR-009): every file is written to a temp name and renamed, so a reader sees an
// old or a new version, never half of one; a byte offset never moves backwards; a spool file is
// claimed by renaming it, so two flushers never both send it; locks are O_EXCL files with an expiry.
import { createHash } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync,
  rmSync, statSync, writeFileSync, writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const SPOOL_CAP_BYTES = 50 * 1024 * 1024;
export const LOG_CAP_BYTES = 1024 * 1024;
export const BACKOFF_MS = 5 * 60 * 1000;
const CLAIM_STALE_MS = 10 * 60 * 1000;

export function paths(configDir) {
  const root = join(configDir, 'usage');
  return {
    root,
    state: join(root, 'state'),
    byCwd: join(root, 'state', 'by-cwd'),
    worktrees: join(root, 'state', 'worktrees.json'),
    sweep: join(root, 'state', 'sweep.json'),
    spool: join(root, 'spool'),
    drops: join(root, 'spool-drops.json'),
    locks: join(root, 'locks'),
    token: join(root, 'token.json'),
    tokenState: join(root, 'token-state.json'),
    ship: join(root, 'ship.json'),
    backoff: join(root, 'backoff'),
    log: join(root, 'cc-usage.log'),
  };
}

let tmpN = 0;
/** Write `text` to `file` via a temp name in the same directory and rename. */
export function writeAtomic(file, text, { mode } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${tmpN++}`;
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode });
  renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const sessionFile = (configDir, id) => join(paths(configDir).state, `${id}.json`);

export function readSessionState(configDir, sessionId) {
  return readJson(sessionFile(configDir, sessionId), null);
}

/**
 * Merge-write a session's state. Per file, the entry with the LARGER offset wins, so a slow process
 * that parsed less can never move an offset backwards. Other keys are last-writer-wins.
 */
export function writeSessionState(configDir, sessionId, next) {
  const prev = readSessionState(configDir, sessionId) ?? {};
  const files = { ...(prev.files ?? {}) };
  for (const [k, v] of Object.entries(next.files ?? {})) {
    if (!files[k] || (v?.offset ?? 0) >= (files[k].offset ?? 0)) files[k] = v;
  }
  writeAtomic(sessionFile(configDir, sessionId), JSON.stringify({ ...prev, ...next, files }));
}

/** Take a named lock; a lock older than ttlMs is stale and reclaimed. */
export function acquireLock(configDir, name, { now = Date.now(), ttlMs = 60_000 } = {}) {
  const dir = paths(configDir).locks;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: now }));
      closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return false;
      const held = readJson(file, null);
      const at = held?.at ?? (() => { try { return statSync(file).mtimeMs; } catch { return now; } })();
      if (now - at <= ttlMs) return false;
      // Stale: reclaim by renaming it away first, so only one reclaimer can win.
      try {
        renameSync(file, `${file}.stale-${process.pid}-${tmpN++}`);
        rmSync(`${file}.stale-${process.pid}-${tmpN - 1}`, { force: true });
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function releaseLock(configDir, name) {
  rmSync(join(paths(configDir).locks, `${name}.lock`), { force: true });
}

// ---- spool: <ts>-<sessionId>-<pid>-<n>.ndjson; claimed as <name>.claimed-<pid>

function spoolFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith('.ndjson')).sort();
}

export function spoolDepth(configDir) {
  const dir = paths(configDir).spool;
  let bytes = 0;
  const files = spoolFiles(dir);
  for (const n of files) {
    try { bytes += statSync(join(dir, n)).size; } catch { /* claimed meanwhile */ }
  }
  return { files: files.length, bytes };
}

export function readSpoolDrops(configDir) {
  return readJson(paths(configDir).drops, []);
}

/**
 * Spool one failed batch. Written ONLY when the store is configured (FR-010). Enforces the cap by
 * deleting the oldest files first and recording each drop for `doctor` (the sweep re-derives a
 * dropped range from its transcript).
 */
export function spoolWrite(configDir, entry, { configured, now = Date.now(), capBytes = SPOOL_CAP_BYTES } = {}) {
  if (!configured) return false;
  const p = paths(configDir);
  mkdirSync(p.spool, { recursive: true });
  const name = `${String(now).padStart(15, '0')}-${entry.sessionId}-${process.pid}-${tmpN++}.ndjson`;
  writeAtomic(join(p.spool, name), JSON.stringify(entry) + '\n');
  let { bytes } = spoolDepth(configDir);
  const drops = [];
  for (const n of spoolFiles(p.spool)) {
    if (bytes <= capBytes || n === name) break;
    const f = join(p.spool, n);
    try {
      const size = statSync(f).size;
      const old = readJson(f, null);
      rmSync(f, { force: true });
      bytes -= size;
      drops.push({ sessionId: old?.sessionId ?? null, range: old?.range ?? null, at: new Date(now).toISOString() });
    } catch { /* claimed by a flusher meanwhile */ }
  }
  if (drops.length) writeAtomic(p.drops, JSON.stringify([...readSpoolDrops(configDir), ...drops].slice(-100)));
  return true;
}

/** Claim spooled batches (oldest first), optionally for one session, by renaming each. */
export function spoolClaim(configDir, { sessionId, now = Date.now() } = {}) {
  const dir = paths(configDir).spool;
  if (!existsSync(dir)) return [];
  // Release claims abandoned by a killed flusher.
  for (const n of readdirSync(dir).filter((x) => /\.claimed-\d+$/.test(x))) {
    const f = join(dir, n);
    try {
      if (now - statSync(f).mtimeMs > CLAIM_STALE_MS) renameSync(f, f.replace(/\.claimed-\d+$/, ''));
    } catch { /* gone */ }
  }
  const out = [];
  for (const n of spoolFiles(dir)) {
    if (sessionId && !n.includes(`-${sessionId}-`)) continue;
    const f = join(dir, n);
    const claimedPath = `${f}.claimed-${process.pid}`;
    try {
      renameSync(f, claimedPath);
    } catch {
      continue; // another flusher won
    }
    const entry = readJson(claimedPath, null);
    if (!entry) {
      rmSync(claimedPath, { force: true });
      continue;
    }
    out.push({ claimedPath, entry });
  }
  return out;
}

export function spoolComplete(claimedPath) {
  rmSync(claimedPath, { force: true });
}

export function spoolRelease(claimedPath) {
  try {
    renameSync(claimedPath, claimedPath.replace(/\.claimed-\d+$/, ''));
  } catch { /* already gone */ }
}

// ---- back-off

export function writeBackoff(configDir, now = Date.now()) {
  writeAtomic(paths(configDir).backoff, String(now));
}

export function backoffActive(configDir, { now = Date.now(), windowMs = BACKOFF_MS } = {}) {
  const raw = (() => { try { return readFileSync(paths(configDir).backoff, 'utf8'); } catch { return null; } })();
  const at = Number(raw);
  return Number.isFinite(at) && raw !== null && now - at < windowMs;
}

// ---- log: JSON lines; never throws; never the token, a host name or content (callers' duty)

export function log(configDir, entry, { capBytes = LOG_CAP_BYTES, now = Date.now() } = {}) {
  try {
    const file = paths(configDir).log;
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size >= capBytes) renameSync(file, `${file}.1`);
    } catch { /* no log yet */ }
    appendFileSync(file, JSON.stringify({ ts: new Date(now).toISOString(), level: 'info', service: 'cc-usage', ...entry }) + '\n');
  } catch {
    // Logging must never degrade the host process.
  }
}

/** Live-session marker for the skill fallback (research R7), keyed by a hash of the cwd. */
export function writeCwdMarker(configDir, cwd, sessionId, now = Date.now()) {
  const h = createHash('sha1').update(String(cwd)).digest('hex').slice(0, 16);
  writeAtomic(join(paths(configDir).byCwd, `${h}.json`), JSON.stringify({ sessionId, at: now }));
}
