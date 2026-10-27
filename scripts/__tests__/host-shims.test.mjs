// The fake-host harness the backup-script suites run against (spec 084 T003). Pinned on its own
// because every backup test trusts it: a shim that silently swallowed an exit code, or recorded a
// header file's contents, would turn those suites into false greens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeShimEnv } from './host-shims.mjs';

const script = (env, body) => {
  const p = join(env.home, 'probe.sh');
  writeFileSync(p, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  return p;
};

test('a shim records its argv, in call order', () => {
  const env = makeShimEnv();
  const r = env.run(script(env, 'docker exec komodo-postgres-1 pg_dumpall\nrestic snapshots --json'));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    env.calls().map((c) => [c.cmd, ...c.argv]),
    [['docker', 'exec', 'komodo-postgres-1', 'pg_dumpall'], ['restic', 'snapshots', '--json']],
  );
});

test('the first matching fixture answers: stdout, stderr and exit code all propagate', () => {
  const env = makeShimEnv({
    fixtures: [
      { cmd: 'docker', match: ['forgejo dump'], stderr: 'disk full', exit: 7 },
      { cmd: 'docker', match: ['exec'], stdout: 'dumped' },
    ],
  });
  const r = env.run(script(env, 'docker exec x forgejo dump || echo "rc=$?"\ndocker exec y pg_dump'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rc=7/);
  assert.match(r.stdout, /dumped/);
  assert.match(r.stderr, /disk full/);
});

test('an @data file is captured, but an @header file never is (a token travels that way)', () => {
  const env = makeShimEnv();
  const r = env.run(script(env, [
    'echo "Authorization: token s3cr3t-value" > "$HOME/h"',
    'echo \'{"title":"x"}\' > "$HOME/body.json"',
    'curl -fsS -H @"$HOME/h" --data-binary @"$HOME/body.json" http://forge/api',
  ].join('\n')));
  assert.equal(r.status, 0, r.stderr);
  const [call] = env.calls();
  assert.deepEqual(Object.values(call.dataFiles), ['{"title":"x"}\n']);
  assert.doesNotMatch(env.rawCalls(), /s3cr3t-value/);
});

test('an unshimmed tool is the real one (python3 is not faked unless asked)', () => {
  const env = makeShimEnv();
  const r = env.run(script(env, 'python3 -c "print(6*7)"'));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '42');
  assert.deepEqual(env.calls(), []);
});
