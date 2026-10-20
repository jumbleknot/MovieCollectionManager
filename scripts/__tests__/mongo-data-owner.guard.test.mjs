// Feature 081 US8a — the tripwire that keeps a MongoDB image move from bricking a populated volume.
//
// THE TRAP THIS EXISTS FOR. `mongodb/mongodb-community-server:8.0.8-ubi9` runs mongod as uid 998;
// `9.0-ubi9` runs it as uid 1000. A volume written by 8.0.8 is therefore foreign-owned to 9.0, and 9.0
// dies at start with `Unable to read the storage engine metadata file ... storage.bson` (FileNotOpen) —
// MEASURED 2026-10-20 on a copy of the dev volumes, before any data was touched. Nothing in the image
// fixes it: its entrypoint, started as root, does NOT drop privileges (mongod then runs as root).
//
// So every MongoDB service that mounts /data/db starts as root ONLY to re-own the data dir, then drops
// to the image's `mongod` user with setpriv before mongod (or the keyfile entrypoint) runs. Remove the
// wrapper and the next uid change — or a restore made by a different image — is an outage on the
// populated prod stores; remove the drop and mongod runs as root. Both halves are asserted here, on
// the dev files AND the prod files, and the wrapper is executed against stubs so the assertion is
// about what it DOES, not how it is spelled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FILES = [
  'infrastructure-as-code/docker/bff/compose.yaml',
  'infrastructure-as-code/docker/bff/compose.prod.yaml',
  'infrastructure-as-code/docker/mc-service/compose.yaml',
  'infrastructure-as-code/docker/mc-service/compose.prod.yaml',
];
const MONGO_IMAGE = /^mongodb\/mongodb-community-server:/;

function mongoDataServices(rel) {
  const services = parseYaml(readFileSync(resolve(REPO_ROOT, rel), 'utf8'))?.services ?? {};
  return Object.entries(services).filter(
    ([, svc]) =>
      MONGO_IMAGE.test(String(svc?.image ?? '')) &&
      (svc?.volumes ?? []).some((v) => String(typeof v === 'string' ? v : v?.target).includes('/data/db')),
  );
}

// Compose interpolation turns `$$` into `$`; YAML hands us the escaped form.
const unescapeCompose = (script) => script.replaceAll('$$', '$');

test('every MongoDB service that mounts /data/db starts as root only to run the ownership wrapper', () => {
  for (const rel of FILES) {
    const found = mongoDataServices(rel);
    // A rename would otherwise make every assertion below pass vacuously.
    assert.ok(found.length >= 1, `${rel}: no MongoDB service mounting /data/db (renamed? re-derive this guard)`);
    for (const [name, svc] of found) {
      const ep = svc.entrypoint;
      assert.equal(String(svc.user), '0:0', `${rel} ${name}: must start as root to re-own /data/db`);
      assert.ok(Array.isArray(ep) && ep[0] === 'sh' && ep[1] === '-c', `${rel} ${name}: entrypoint is not the sh -c wrapper`);
      assert.equal(ep[3], 'mongo-data-owner', `${rel} ${name}: wrapper's $0 must be mongo-data-owner`);
      assert.ok(ep.length > 4, `${rel} ${name}: the wrapper hands off to nothing`);
      assert.equal(svc.command?.[0], 'mongod', `${rel} ${name}: command must start mongod`);
    }
  }
});

test('the wrapper is one script, identical in all four files', () => {
  const scripts = FILES.flatMap((rel) => mongoDataServices(rel).map(([, svc]) => svc.entrypoint?.[2]));
  assert.equal(new Set(scripts).size, 1, 'the mongo-data-owner wrapper has drifted between compose files');
});

function runWrapper({ uid, foreign }) {
  const [, svc] = mongoDataServices(FILES[0])[0];
  const script = unescapeCompose(svc.entrypoint[2]);
  const dir = mkdtempSync(join(tmpdir(), 'mongo-data-owner-'));
  const log = join(dir, 'calls.log');
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub('id', `if [ "$2" = mongod ]; then echo 1000; else echo ${uid}; fi`);
  stub('find', `echo "find $*" >> ${log}; ${foreign ? 'echo /data/db/storage.bson' : 'true'}`);
  stub('chown', `echo "chown $*" >> ${log}`);
  stub('setpriv', `echo "setpriv $*" >> ${log}`);
  stub('mongod', `echo "mongod-as-is $*" >> ${log}`);
  try {
    execFileSync('sh', ['-c', script, 'mongo-data-owner', 'mongod', '--bind_ip_all'], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      stdio: 'pipe',
    });
    return readFileSync(log, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('as root with foreign-owned data: re-owns /data/db, then drops to mongod before exec', () => {
  const calls = runWrapper({ uid: 0, foreign: true }).trim().split('\n');
  assert.ok(calls.some((c) => c === 'chown -R mongod:mongod /data/db'), `no chown in: ${calls.join(' | ')}`);
  const last = calls.at(-1);
  assert.equal(last, 'setpriv --reuid=mongod --regid=mongod --init-groups mongod --bind_ip_all');
  assert.ok(!calls.some((c) => c.startsWith('mongod-as-is')), 'mongod ran without dropping privileges');
});

test('as root with data already owned: no chown, still drops to mongod', () => {
  const calls = runWrapper({ uid: 0, foreign: false });
  assert.doesNotMatch(calls, /^chown/m);
  assert.match(calls, /^setpriv --reuid=mongod --regid=mongod --init-groups mongod --bind_ip_all$/m);
  // mongosh's own client log dir (HOME=/data/db) is root-written by `docker exec`; it must not
  // trigger a re-own on every start.
  assert.match(calls, /-path \/data\/db\/\.mongodb -prune/);
});

test('not root: execs the command unchanged (no chown, no setpriv)', () => {
  const calls = runWrapper({ uid: 1000, foreign: true });
  assert.doesNotMatch(calls, /^(chown|setpriv)/m);
  assert.match(calls, /^mongod-as-is --bind_ip_all$/m);
});
