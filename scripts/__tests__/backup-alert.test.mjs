// infrastructure-as-code/backup/backup-alert.sh — puts a backup failure in front of the operator
// (spec 084 FR-001/FR-002, research R1, contracts/cli-contracts.md).
//
// The July–October outage left a `Failed with result 'exit-code'` line in the journal every night
// and nothing read it. The alert goes where the operator already looks — ONE open backlog item,
// commented on by every later event, never duplicated and never closed by a machine. Unit tier:
// curl/systemctl/journalctl are shims, so each case asserts the exact API calls made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeShimEnv } from './host-shims.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(REPO_ROOT, 'infrastructure-as-code/backup/backup-alert.sh');
const TITLE = 'Prod backup: failed or stale';
const TOKEN = 'tok-0123456789abcdef';
const LABELS = JSON.stringify([{ id: 11, name: 'type/bug' }, { id: 22, name: 'priority/p1' }, { id: 33, name: 'type/chore' }]);

/** A host with the token and forge URL installed, and the given open issues. */
function alertHost({ open = [], extraFixtures = [], tokenMode = 0o600, token = true, url = true } = {}) {
  const env = makeShimEnv({ shims: ['curl', 'systemctl', 'journalctl'] });
  env.setFixtures([
    ...extraFixtures,
    { cmd: 'curl', match: ['/comments'], stdout: '{"id":1}' },
    { cmd: 'curl', match: ['POST'], stdout: '{"number":901}' },
    { cmd: 'curl', match: ['/labels'], stdout: LABELS },
    { cmd: 'curl', match: ['type=issues'], stdout: JSON.stringify(open) },
    { cmd: 'journalctl', stdout: 'Oct 22 03:31 backup.sh: write /dev/stdout: no space left on device\n' },
    { cmd: 'systemctl', match: ['Result'], stdout: 'Result=exit-code\n' },
  ]);
  if (token) {
    const t = join(env.home, 'backup/forge-issue-token');
    writeFileSync(t, `${TOKEN}\n`);
    chmodSync(t, tokenMode);
  }
  if (url) writeFileSync(join(env.home, 'backup/alert.env'), 'MCM_FORGE_URL=http://forge.example:3000\n');
  return env;
}

const posts = (env) => env.calls().filter((c) => c.cmd === 'curl' && c.argv.includes('POST'));
const bodyOf = (call) => JSON.parse(Object.values(call.dataFiles)[0]);
const detail = (env, text) => {
  const p = join(env.home, 'detail.txt');
  writeFileSync(p, text);
  return p;
};

test('with no open item, it creates one: exact title, type/bug + priority/p1 by label id', () => {
  const env = alertHost();
  const r = env.run(SCRIPT, ['stale', detail(env, 'newest snapshot is 37 h old')]);
  assert.equal(r.status, 0, r.stderr);
  const [create] = posts(env);
  assert.ok(create.argv.at(-1).endsWith('/api/v1/repos/jumbleknot/mcm/issues'), create.argv.at(-1));
  const body = bodyOf(create);
  assert.equal(body.title, TITLE);
  assert.deepEqual(body.labels.sort(), [11, 22]);
  assert.match(body.body, /stale/);
  assert.match(body.body, /newest snapshot is 37 h old/);
});

test('with an open item, it comments on it and never opens a second one', () => {
  const env = alertHost({ open: [{ number: 870, title: TITLE }, { number: 871, title: `${TITLE} (old copy)` }] });
  assert.equal(env.run(SCRIPT, ['failed', 'homelab-backup.service']).status, 0);
  const p = posts(env);
  assert.equal(p.length, 1);
  assert.ok(p[0].argv.at(-1).endsWith('/issues/870/comments'), 'matched on the EXACT title');
  assert.match(bodyOf(p[0]).body, /failed/);
});

test('the search asks for issues only and sends no label filter (an unknown label is silently ignored)', () => {
  const env = alertHost();
  env.run(SCRIPT, ['stale', '-']);
  const search = env.calls().find((c) => c.cmd === 'curl' && c.argv.some((a) => a.includes('type=issues')));
  const url = search.argv.find((a) => a.includes('type=issues'));
  assert.match(url, /state=open/);
  assert.doesNotMatch(url, /labels=/);
});

test('recovered comments on an open item, does nothing when none is open, and never closes', () => {
  let env = alertHost();
  let r = env.run(SCRIPT, ['recovered', '-']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(posts(env), []);

  env = alertHost({ open: [{ number: 870, title: TITLE }] });
  r = env.run(SCRIPT, ['recovered', '-']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(posts(env).length, 1);
  assert.match(bodyOf(posts(env)[0]).body, /recovered/);
  assert.doesNotMatch(env.rawCalls(), /PATCH|"state"\s*:\s*"closed"/, 'closing stays a human act');
});

test('a failed unit whose result is timeout is reported as hung; any other result as failed', () => {
  for (const [result, reason] of [['timeout', 'hung'], ['exit-code', 'failed']]) {
    const env = alertHost({ extraFixtures: [{ cmd: 'systemctl', match: ['Result'], stdout: `Result=${result}\n` }] });
    assert.equal(env.run(SCRIPT, ['failed', 'homelab-backup.service']).status, 0);
    const body = bodyOf(posts(env)[0]).body;
    assert.match(body, new RegExp(`reason: ${reason}\\b`));
    assert.match(body, /no space left on device/, 'the journal tail is the detail');
  }
});

test('an unknown reason is refused before any network call', () => {
  const env = alertHost();
  const r = env.run(SCRIPT, ['broken', '-']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
  assert.deepEqual(env.calls().filter((c) => c.cmd === 'curl'), []);
});

test('a missing or loose token file, or no forge URL, exits 3: alert NOT delivered', () => {
  for (const opts of [{ token: false }, { tokenMode: 0o644 }, { url: false }]) {
    const env = alertHost(opts);
    const r = env.run(SCRIPT, ['stale', '-']);
    assert.equal(r.status, 3, `${JSON.stringify(opts)}: ${r.stderr}`);
    assert.match(r.stderr, /alert NOT delivered/);
    assert.deepEqual(env.calls().filter((c) => c.cmd === 'curl'), []);
  }
});

test('an HTTP failure exits 4', () => {
  const env = alertHost({ extraFixtures: [{ cmd: 'curl', match: ['POST'], stderr: 'curl: (22) 500', exit: 22 }] });
  const r = env.run(SCRIPT, ['stale', '-']);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /alert NOT delivered/);
});

test('the token never appears in argv, output, or anything the shims recorded', () => {
  const env = alertHost({ open: [{ number: 870, title: TITLE }] });
  const r = env.run(SCRIPT, ['failed', 'homelab-backup.service']);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN));
  assert.doesNotMatch(env.rawCalls(), new RegExp(TOKEN));
  for (const c of env.calls().filter((x) => x.cmd === 'curl')) {
    assert.ok(c.argv.some((a, i) => c.argv[i - 1] === '-H' && a.startsWith('@')), 'token via -H @file');
  }
});

test('the detail is redacted: URI user-info masked, credential-bearing lines dropped', () => {
  const env = alertHost();
  const r = env.run(SCRIPT, ['stale', detail(env, [
    'mongodump --uri=mongodb://mcuser:hunter2@127.0.0.1:27017/mc failed',
    'PGPASSWORD=hunter2 pg_dump exited 1',
    'curl -H Authorization: token abc failed',
    'restic: repository locked',
  ].join('\n'))]);
  assert.equal(r.status, 0, r.stderr);
  const body = bodyOf(posts(env)[0]).body;
  assert.match(body, /mongodb:\/\/\*\*\*@127\.0\.0\.1:27017\/mc failed/);
  assert.match(body, /restic: repository locked/);
  assert.doesNotMatch(body, /hunter2|PGPASSWORD|Authorization/);
});
