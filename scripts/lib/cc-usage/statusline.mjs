// Feature 105 US4 — the OPT-IN statusline wrapper (FR-033; research R14, spike (i)). Claude Code pipes
// its statusline JSON on stdin; this records the latest `rate_limits` snapshot locally, derives the
// per-activity plan-limit burn from two successive snapshots, then runs the user's own statusline
// (CC_USAGE_STATUSLINE_NEXT) with the same stdin and returns its output untouched. It never throws, and
// it reads no transcript: the session's current activity comes from the summary capture keeps.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from './capture.mjs';
import { readJson, readSessionState, writeAtomic } from './local-state.mjs';

const WINDOWS = ['five_hour', 'seven_day'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function currentActivity(configDir, sessionId) {
  const ta = readSessionState(configDir, sessionId)?.summary?.turnActivity ?? {};
  const last = Object.keys(ta).map(Number).sort((a, b) => b - a)[0];
  return last !== undefined ? ta[last] : 'unclassified';
}

function record(cfg, j) {
  const rl = j?.rate_limits;
  if (!rl || typeof rl !== 'object') return;
  const file = join(cfg.configDir, 'usage', 'ratelimits.json');
  const prev = readJson(file, null) ?? {};
  const sessionId = UUID.test(String(j.session_id ?? '')) ? j.session_id : null;
  const latest = { at: new Date(cfg.now()).toISOString(), session_id: sessionId };
  for (const w of WINDOWS) {
    const v = rl[w];
    if (v && Number.isFinite(Number(v.used_percentage))) latest[w] = { used_percentage: Number(v.used_percentage), resets_at: v.resets_at ?? null };
  }
  const burn = prev.burnByActivity ?? {};
  if (prev.latest && sessionId) {
    const activity = currentActivity(cfg.configDir, sessionId);
    for (const w of WINDOWS) {
      const a = prev.latest[w];
      const b = latest[w];
      // Same window only; a drop is a reset, never negative burn.
      if (!a || !b || a.resets_at !== b.resets_at) continue;
      const d = Math.max(0, Math.round((b.used_percentage - a.used_percentage) * 1000) / 1000);
      if (!d) continue;
      burn[activity] ??= Object.fromEntries(WINDOWS.map((x) => [x, 0]));
      burn[activity][w] = Math.round((burn[activity][w] + d) * 1000) / 1000;
    }
  }
  writeAtomic(file, JSON.stringify({ latest, previous: prev.latest ?? null, burnByActivity: burn }));
}

/** @returns {string} exactly what the next statusline command printed ('' when none) */
export function statusline(stdinText, env = process.env) {
  let cfg;
  try {
    cfg = loadConfig(env);
    record(cfg, JSON.parse(stdinText));
  } catch { /* never disturb the statusline */ }
  const next = env.CC_USAGE_STATUSLINE_NEXT;
  if (!next) return '';
  try {
    const r = spawnSync('sh', ['-c', next], { input: stdinText, encoding: 'utf8', timeout: 2000, env });
    return r.stdout ?? '';
  } catch {
    return '';
  }
}
