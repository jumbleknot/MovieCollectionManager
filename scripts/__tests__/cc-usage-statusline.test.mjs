// Feature 105 US4 — the opt-in statusline wrapper (FR-033; research R14, spike (i); US4-AC5). T058.
// It records `rate_limits` locally and prints whatever the user's own statusline prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envFor, runCli, tempConfigDir, SESSION } from './cc-usage-test-support.mjs';

const input = (five, seven, extra = {}) => JSON.stringify({
  session_id: SESSION.A, model: { display_name: 'Opus' },
  rate_limits: { five_hour: { used_percentage: five, resets_at: 1795400000 }, seven_day: { used_percentage: seven, resets_at: 1795900000 } }, ...extra,
});

async function withDir(fn) {
  const cfg = tempConfigDir();
  try { await fn(cfg.dir); } finally { cfg.cleanup(); }
}

test('stores the latest rate_limits and prints exactly the next command\'s output', () => withDir(async (dir) => {
  const env = envFor(dir, null, { CC_USAGE_STATUSLINE_NEXT: "printf 'my line %s' \"$(cat | wc -c | tr -d ' ')\"" });
  const stdin = input(10, 40);
  const r = await runCli(['statusline'], { env, stdin });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `my line ${Buffer.byteLength(stdin)}`, 'the next command got the same stdin, and its output is passed through untouched');
  const rl = JSON.parse(readFileSync(join(dir, 'usage', 'ratelimits.json'), 'utf8'));
  assert.deepEqual(rl.latest.five_hour, { used_percentage: 10, resets_at: 1795400000 });
  assert.equal(rl.latest.session_id, SESSION.A);
}));

test('prints nothing when no next command is set', () => withDir(async (dir) => {
  const r = await runCli(['statusline'], { env: envFor(dir, null), stdin: input(1, 2) });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', '']);
}));

test('never exits non-zero: garbage stdin, a failing next command, no rate_limits', () => withDir(async (dir) => {
  for (const [stdin, next] of [['not json', undefined], [input(1, 2), 'exit 7'], [JSON.stringify({ session_id: SESSION.A }), undefined]]) {
    const r = await runCli(['statusline'], { env: envFor(dir, null, next ? { CC_USAGE_STATUSLINE_NEXT: next } : {}), stdin });
    assert.equal(r.code, 0, `${stdin} / ${next}`);
  }
  assert.ok(!existsSync(join(dir, 'usage', 'ratelimits.json')) || JSON.parse(readFileSync(join(dir, 'usage', 'ratelimits.json'), 'utf8')).latest.five_hour.used_percentage === 1);
}));

test('per-activity limit burn comes from two successive snapshots', () => withDir(async (dir) => {
  const env = envFor(dir, null);
  await runCli(['statusline'], { env, stdin: input(10, 40) });
  await runCli(['statusline'], { env, stdin: input(17, 41.5) });
  const rl = JSON.parse(readFileSync(join(dir, 'usage', 'ratelimits.json'), 'utf8'));
  const acts = Object.keys(rl.burnByActivity);
  assert.equal(acts.length, 1, 'attributed to the session\'s current activity');
  assert.deepEqual(rl.burnByActivity[acts[0]], { five_hour: 7, seven_day: 1.5 });
}));

test('a window reset (usage drops) is not counted as negative burn', () => withDir(async (dir) => {
  const env = envFor(dir, null);
  await runCli(['statusline'], { env, stdin: input(90, 40) });
  await runCli(['statusline'], { env, stdin: input(3, 40) });
  const rl = JSON.parse(readFileSync(join(dir, 'usage', 'ratelimits.json'), 'utf8'));
  for (const v of Object.values(rl.burnByActivity ?? {})) assert.ok(v.five_hour >= 0);
}));
