// Feature 080 (item #560) — the end-to-end rehearsal of the MinIO → RustFS migration, on Docker.
//
//   MCM_REQUIRE_LIVE_STACK=1 node --test scripts/__tests__/object-store-migration.rehearsal.mjs
//   node scripts/object-store-migration.mjs rehearse          # the same, skipping forbidden
//
// DELIBERATELY NOT A *.test.mjs. guardrails runs `node --test scripts/__tests__/*.test.mjs` on a
// runner with no Docker daemon (research R13), so this file is outside that glob. The tool's pure
// logic is tested there; this file proves the Docker-driving half, as the operator will run it:
// every step below is the CLI, invoked exactly as contracts/migration-procedure.md writes it.
//
// A SKIP IS NOT A PASS. Without a reachable daemon this file skips — unless MCM_REQUIRE_LIVE_STACK=1,
// which turns the skip into a failure (CLAUDE.md: "a skipped test reads as a pass"). The same holds
// for the old MinIO image: without REGISTRY_HOST it cannot seed a realistic drive, and pretending
// with any other writer would rehearse a drive production does not have.
//
// THE SCENARIO (tasks.md T008): seed a drive with the CURRENTLY DEPLOYED MinIO — an inline object, a
// 2 MB object, a multipart object, 50 small JSON objects under deep prefixes, awkward key
// characters, and a versioned bucket holding two versions and a delete marker → manifest → stop →
// inventory → copy --apply → RustFS (pinned, NO `user:`) on the copy → verify → the source is
// byte-identical → stop RustFS, start MinIO on the ORIGINAL and re-read everything (rollback).
// Plus: RustFS on a FRESH volume becomes healthy and the S5 bucket init is idempotent; a planted
// ETag and checksum mismatch FAIL verify; an `fs`-layout drive and an SSE-marked xl.meta make
// inventory refuse; a missing volume is refused and NOT created (feature 070 trap 1); and the
// production wrapper (object-store-migration.sh) runs inventory to the same digest.
//
// Every scratch resource carries the prefix below and is removed in `after`, pass or fail.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const TOOL = resolve(REPO_ROOT, 'scripts/object-store-migration.mjs');
const WRAPPER = resolve(REPO_ROOT, 'scripts/object-store-migration.sh');

// The MinIO digest production runs today (features 069/070). The ONLY place it may still be named
// after feature 080 merges, and only until the cleanup PR (contracts/no-minio-guard.md G2).
const MINIO_DIGEST = 'sha256:8054a7ce1af3d5f57e508de5f17885ae7892234ac465d1d9cb8e8977358a06a2';
const MINIO = process.env.REGISTRY_HOST ? `${process.env.REGISTRY_HOST}/jumbleknot/minio@${MINIO_DIGEST}` : null;

const REQUIRE = process.env.MCM_REQUIRE_LIVE_STACK === '1';
const P = `s080r${process.pid}`;
const NET = `${P}-net`;
const SRC = `${P}-minio-data`;
const DST = `${P}-rustfs-data`;
const FRESH = `${P}-fresh`;
const FS_FIX = `${P}-fix-fs`;
const SSE_FIX = `${P}-fix-sse`;
const NOTIFY_FIX = `${P}-fix-notify`;
const MISSING = `${P}-never-created`;
const C_MINIO = `${P}-minio`;
const C_RUSTFS = `${P}-rustfs`;
const C_FRESH = `${P}-fresh`;

const OLD_CREDS = { S3_ACCESS_KEY: 'minio', S3_SECRET_KEY: `${P}-old-secret-pw` };
const NEW_CREDS = { S3_ACCESS_KEY: 'langfuse', S3_SECRET_KEY: `${P}-new-secret-pw` };

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...opts, env: { ...process.env, ...(opts.env ?? {}) } });
const dk = (...args) => run('docker', args);
const dkOk = (...args) => {
  const r = dk(...args);
  assert.equal(r.status, 0, `docker ${args.join(' ')}\n${r.stderr}`);
  return r.stdout;
};
const tool = (args, env = {}) => run(process.execPath, [TOOL, ...args], { env, cwd: WORK });
const json = (name) => JSON.parse(readFileSync(join(WORK, name), 'utf8'));

let WORK;
let RUSTFS;
let reason = null;

function why() {
  if (dk('version', '--format', '{{.Server.Version}}').status !== 0) return 'no reachable Docker daemon';
  if (!MINIO) return 'REGISTRY_HOST is not set — the deployed MinIO image cannot be named';
  return null;
}

function waitFor(desc, probe, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (probe()) return;
    spawnSync('sleep', ['1']);
  }
  throw new Error(`timed out waiting for ${desc}`);
}

const ready = (container) => () =>
  dk('exec', container, 'curl', '-fsS', '-o', '/dev/null', 'http://localhost:9000/health/ready').status === 0;

function startRustfs(name, volume, creds) {
  dkOk('run', '-d', '--name', name, '--network', NET, '-e', `RUSTFS_ACCESS_KEY=${creds.S3_ACCESS_KEY}`,
    '-e', 'RUSTFS_SECRET_KEY', '-e', 'RUSTFS_OBS_LOG_DIRECTORY=', '-e', 'RUSTFS_CONSOLE_ENABLE=false',
    '-v', `${volume}:/data`, RUSTFS);
  // RUSTFS_SECRET_KEY by name: the value comes from this process's env, as in compose.
}

function startMinio(volume) {
  dkOk('run', '-d', '--name', C_MINIO, '--network', NET, '-e', `MINIO_ROOT_USER=${OLD_CREDS.S3_ACCESS_KEY}`,
    '-e', `MINIO_ROOT_PASSWORD=${OLD_CREDS.S3_SECRET_KEY}`, '-v', `${volume}:/data`, MINIO, 'server', '/data');
  waitFor('MinIO ready', () => dk('exec', C_MINIO, 'mc', 'ready', 'local').status === 0);
}

const SEED = String.raw`
set -eu
mc alias set r http://localhost:9000 "$U" "$S" >/dev/null
mc mb r/langfuse >/dev/null
printf 'tiny' | mc pipe r/langfuse/events/inline.txt >/dev/null
head -c 2000000 /dev/urandom > /tmp/two && mc cp -q /tmp/two r/langfuse/media/two-mb.bin >/dev/null
head -c 80000000 /dev/urandom > /tmp/big && mc cp -q /tmp/big r/langfuse/media/multipart.bin >/dev/null
i=0
while [ $i -lt 50 ]; do
  printf '{"n":%d}' $i | mc pipe "r/langfuse/events/project/2026/10/11/deep/$i.json" >/dev/null
  i=$((i+1))
done
printf 'space' | mc pipe 'r/langfuse/events/a b/c+d.json' >/dev/null
printf 'umlaut' | mc pipe 'r/langfuse/media/über.txt' >/dev/null
mc mb r/versioned >/dev/null
mc version enable r/versioned >/dev/null
printf 'one' | mc pipe r/versioned/doc >/dev/null
printf 'two!' | mc pipe r/versioned/doc >/dev/null
mc rm r/versioned/doc >/dev/null
mc mb r/lifecycled >/dev/null
mc ilm rule add --expire-days 30 r/lifecycled >/dev/null
echo seeded
`;
const SEEDED_OBJECTS = 55; // langfuse: inline + 2 MB + multipart + 50 + 2 awkward keys; versioned: 0 current

function rmAll() {
  dk('rm', '-f', C_MINIO, C_RUSTFS, C_FRESH);
  for (const v of [SRC, DST, FRESH, FS_FIX, SSE_FIX, NOTIFY_FIX, MISSING]) dk('volume', 'rm', '-f', v);
  dk('network', 'rm', NET);
}

before(() => {
  reason = why();
  if (reason) return;
  RUSTFS = readFileSync(resolve(REPO_ROOT, 'infrastructure-as-code/docker/observability/compose.prod.yaml'), 'utf8')
    .match(/rustfs\/rustfs:[^\s"'@]+@sha256:[0-9a-f]{64}/)?.[0];
  assert.ok(RUSTFS, 'compose.prod.yaml carries no digest-pinned rustfs/rustfs image');
  WORK = mkdtempSync(join(tmpdir(), 's080-rehearsal-'));
  rmAll();
  dkOk('network', 'create', NET);
  dkOk('volume', 'create', SRC);
  startMinio(SRC);
  const r = run('docker', ['exec', '-i', '-e', 'U', '-e', 'S', C_MINIO, 'sh', '-s'], {
    input: SEED, env: { U: OLD_CREDS.S3_ACCESS_KEY, S: OLD_CREDS.S3_SECRET_KEY },
  });
  assert.equal(r.status, 0, `seeding failed: ${r.stderr}`);
});

after(() => {
  if (reason) return;
  rmAll();
  if (WORK && existsSync(WORK)) rmSync(WORK, { recursive: true, force: true });
});

const live = (name, fn) =>
  test(name, (t) => {
    if (reason) {
      if (REQUIRE) assert.fail(`MCM_REQUIRE_LIVE_STACK=1 and the rehearsal cannot run: ${reason}`);
      t.skip(reason);
      return;
    }
    fn(t);
  });

live('manifest lists every object and version the running MinIO serves, and checksums every multipart one', () => {
  const r = tool(['manifest', '--endpoint', `http://${C_MINIO}:9000`, '--network', NET, '--out', 'manifest.json'], OLD_CREDS);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const m = json('manifest.json');
  assert.equal(m.totals.objects, SEEDED_OBJECTS);
  assert.ok(m.objects.some((o) => o.key === 'events/a b/c+d.json'), 'awkward key missing');
  const multipart = m.objects.filter((o) => o.etag.includes('-'));
  assert.ok(multipart.length >= 1, 'no multipart object — the 80 MB upload did not go multipart, so the rehearsal proves less than it claims');
  for (const o of multipart) assert.ok(m.checksums.some((c) => c.key === o.key), `multipart ${o.key} not checksummed`);
  assert.equal(m.checksums.length, SEEDED_OBJECTS, 'fewer than 200 objects: every one is checksummed');
  assert.deepEqual(m.versionedBuckets, ['versioned']);
  assert.equal(m.versions.length, 3, JSON.stringify(m.versions));
  assert.equal(m.versions.filter((v) => v.deleteMarker).length, 1);
});

live('inventory refuses a volume that does not exist, and does NOT create it', () => {
  const r = tool(['inventory', '--volume', MISSING, '--out', 'missing.json']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /does not exist/);
  assert.notEqual(dk('volume', 'inspect', MISSING).status, 0, 'the tool created the volume it was asked to inspect');
});

live('copy is refused while the source is still mounted by a running store', () => {
  const r = tool(['copy', '--from', SRC, '--to', DST, '--out', 'copy-early.json', '--apply']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(json('copy-early.json').reasons.join(' '), /mounted by running/);
  assert.notEqual(dk('volume', 'inspect', DST).status, 0, 'a refused copy created the target');
});

live('inventory of the stopped drive: xl-single, one drive, no SSE, no tiering, versioning seen', () => {
  dkOk('stop', C_MINIO);
  const r = tool(['inventory', '--volume', SRC, '--out', 'inventory.json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const inv = json('inventory.json');
  assert.equal(inv.verdict, 'migratable', inv.reasons.join('; '));
  assert.equal(inv.format, 'xl-single');
  assert.equal(inv.control, inv.xlMetaFiles, 'control count must equal xl.meta files');
  assert.ok(inv.xlMetaFiles >= SEEDED_OBJECTS);
  assert.equal(inv.sseObjects, 0);
  assert.equal(inv.tieredObjects, 0);
  assert.equal(inv.ownerUid, 1000, 'the deployed MinIO runs as 1000 (feature 070)');
  assert.equal(inv.sourceInUse, false);
  const v = inv.buckets.find((b) => b.name === 'versioned');
  assert.ok(v && v.hasMetadataBin && v.versioning, `versioning not detected: ${JSON.stringify(inv.buckets)}`);
  // Negative control: a lifecycle Rule also carries <Status>Enabled</Status>, and must not read as versioning.
  const lc = inv.buckets.find((b) => b.name === 'lifecycled');
  assert.ok(lc && lc.lifecycle && !lc.versioning, `lifecycle misread: ${JSON.stringify(lc)}`);
  assert.equal(inv.buckets.find((b) => b.name === 'langfuse').versioning, false);
});

live('the production wrapper runs inventory to the same digest, and refuses copy without --apply', () => {
  const dir = mkdtempSync(join(tmpdir(), 's080-wrapper-'));
  try {
    const env = { MIGRATION_DIR: dir, MIGRATION_DOCKER_SOCK: process.env.MCM_REHEARSAL_DAEMON_SOCK ?? '/var/run/docker.sock' };
    const refused = run(WRAPPER, ['copy', '--from', SRC, '--to', DST, '--out', 'c.json'], { env });
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /--apply/);
    const r = run(WRAPPER, ['inventory', '--volume', SRC, '--out', 'inventory.json'], { env });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const viaWrapper = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8'));
    assert.equal(viaWrapper.verdict, 'migratable');
    assert.equal(viaWrapper.treeDigest, json('inventory.json').treeDigest);
    assert.equal(viaWrapper.image, RUSTFS, 'the wrapper must read the same pin from compose.prod.yaml');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

live('copy without --apply is refused by the tool and writes nothing', () => {
  const r = tool(['copy', '--from', SRC, '--to', DST, '--out', 'copy.json']);
  assert.equal(r.status, 2);
  assert.notEqual(dk('volume', 'inspect', DST).status, 0);
});

live('copy --apply: new volume, owned by the image uid throughout, source digest unchanged', () => {
  const r = tool(['copy', '--from', SRC, '--to', DST, '--out', 'copy.json', '--apply']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const c = json('copy.json');
  const uid = Number(dkOk('run', '--rm', '--entrypoint', 'id', RUSTFS, '-u').trim());
  assert.equal(c.verdict, 'pass', c.reasons?.join('; '));
  assert.equal(c.targetPreexisted, false);
  assert.equal(c.runtimeUid, uid);
  assert.equal(c.entriesNotOwnedByRuntimeUid, 0);
  assert.equal(c.sourceDigestBefore, c.sourceDigestAfter);
  assert.equal(c.sourceDigestBefore, json('inventory.json').treeDigest);
});

live('a second copy onto the now-existing target is refused', () => {
  const r = tool(['copy', '--from', SRC, '--to', DST, '--out', 'copy-again.json', '--apply']);
  assert.equal(r.status, 1);
  assert.equal(json('copy-again.json').targetPreexisted, true);
});

live('RustFS starts on the copy as the image user and verify passes against the manifest', () => {
  process.env.RUSTFS_SECRET_KEY = NEW_CREDS.S3_SECRET_KEY;
  startRustfs(C_RUSTFS, DST, NEW_CREDS);
  waitFor('RustFS ready on the migrated drive', ready(C_RUSTFS));
  const r = tool(['verify', '--endpoint', `http://${C_RUSTFS}:9000`, '--network', NET, '--manifest', 'manifest.json',
    '--out', 'parity.json'], NEW_CREDS);
  const p = json('parity.json');
  assert.equal(r.status, 0, `${r.stdout}\n${JSON.stringify({ ...p, totals: p.totals }, null, 1).slice(0, 2000)}`);
  assert.equal(p.verdict, 'pass');
  assert.deepEqual(p.totals.new, p.totals.old);
  assert.equal(p.checksummed, SEEDED_OBJECTS);
});

live('the OLD credential pair is rejected by RustFS — credentials are not baked into the drive', () => {
  const r = tool(['manifest', '--endpoint', `http://${C_RUSTFS}:9000`, '--network', NET, '--out', 'old-creds.json'], OLD_CREDS);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HTTP 403|InvalidAccessKeyId|AccessDenied|SignatureDoesNotMatch/);
});

live('verify FAILS on a planted ETag mismatch and a planted checksum mismatch, naming the object', () => {
  const m = json('manifest.json');
  const victim = m.objects.find((o) => o.key === 'media/two-mb.bin');
  victim.etag = '"00000000000000000000000000000000"';
  const sum = m.checksums.find((c) => c.key === 'events/inline.txt');
  sum.sha256 = '0'.repeat(64);
  writeFileSync(join(WORK, 'manifest-planted.json'), JSON.stringify(m));
  const r = tool(['verify', '--endpoint', `http://${C_RUSTFS}:9000`, '--network', NET, '--manifest', 'manifest-planted.json',
    '--out', 'parity-planted.json'], NEW_CREDS);
  assert.equal(r.status, 1, r.stdout);
  const p = json('parity-planted.json');
  assert.equal(p.verdict, 'fail');
  assert.deepEqual(p.etagMismatch.map((o) => o.key), ['media/two-mb.bin']);
  assert.deepEqual(p.checksumMismatch.map((o) => o.key), ['events/inline.txt']);
});

live('the source drive is byte-identical after RustFS has run on the copy', () => {
  dkOk('stop', C_RUSTFS);
  const r = tool(['inventory', '--volume', SRC, '--out', 'inventory-after.json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(json('inventory-after.json').treeDigest, json('inventory.json').treeDigest);
});

live('rollback: MinIO on the ORIGINAL drive serves every original object, byte for byte', () => {
  dk('rm', '-f', C_MINIO);
  startMinio(SRC);
  const r = tool(['verify', '--endpoint', `http://${C_MINIO}:9000`, '--network', NET, '--manifest', 'manifest.json',
    '--out', 'rollback-parity.json'], OLD_CREDS);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(json('rollback-parity.json').verdict, 'pass');
  dkOk('stop', C_MINIO);
});

live('RustFS on a FRESH volume becomes healthy as the image user, and the S5 bucket init is idempotent', () => {
  dkOk('volume', 'create', FRESH);
  startRustfs(C_FRESH, FRESH, NEW_CREDS);
  waitFor('RustFS ready on a fresh volume', ready(C_FRESH));
  // contracts/object-store-service.md S5, verbatim apart from the host: creds from the container's
  // environment, fed to curl on stdin — never in argv.
  const init = String.raw`printf 'user = "%s:%s"\n' "$S3_ACCESS_KEY" "$S3_SECRET_KEY" | curl -fsS -K - --aws-sigv4 "aws:amz:us-east-1:s3" -o /dev/null -w '%{http_code}' -X PUT http://${C_FRESH}:9000/langfuse`;
  for (const attempt of ['create', 'existing']) {
    const r = run('docker', ['run', '--rm', '--network', NET, '-e', 'S3_ACCESS_KEY', '-e', 'S3_SECRET_KEY',
      '--entrypoint', 'sh', RUSTFS, '-c', init], { env: NEW_CREDS });
    assert.equal(r.status, 0, `${attempt}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), '200', `${attempt} bucket PUT`);
  }
});

function fixture(volume, script) {
  dkOk('volume', 'create', volume);
  const r = run('docker', ['run', '--rm', '-i', '--user', '0:0', '-v', `${volume}:/data`, '--entrypoint', 'sh', RUSTFS, '-s'], { input: script });
  assert.equal(r.status, 0, r.stderr);
}

live('inventory REFUSES a legacy fs-layout drive', () => {
  fixture(FS_FIX, `mkdir -p /data/.minio.sys /data/langfuse && printf '%s' '{"version":"1","format":"fs","id":"x","fs":{"version":"2"}}' > /data/.minio.sys/format.json && echo hi > /data/langfuse/obj`);
  const r = tool(['inventory', '--volume', FS_FIX, '--out', 'fix-fs.json']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const inv = json('fix-fs.json');
  assert.equal(inv.verdict, 'refused');
  assert.match(inv.reasons.join(' '), /"fs"/);
});

live('inventory REFUSES a drive holding one REAL SSE-S3 object written by the deployed MinIO', () => {
  // Not a planted string: the deployed image, a static KMS key, one `mc cp --enc-s3`. The marker then
  // sits deep inside binary msgpack — the case BusyBox grep MISSES in its default locale (measured
  // 2026-10-11: 0 by default, 1 with LC_ALL=C) while the `XL2 ` control still reads N of N.
  const C_SSE = `${P}-sse-minio`;
  try {
    dkOk('volume', 'create', SSE_FIX);
    dkOk('run', '-d', '--name', C_SSE, '-e', `MINIO_ROOT_USER=${OLD_CREDS.S3_ACCESS_KEY}`, '-e', `MINIO_ROOT_PASSWORD=${OLD_CREDS.S3_SECRET_KEY}`,
      '-e', 'MINIO_KMS_SECRET_KEY=s080-rehearsal-key:OSMM+vkKUTCvQs9YL/CVMIMt43HFhkUpqJxTmGl6rYw=', '-v', `${SSE_FIX}:/data`, MINIO, 'server', '/data');
    waitFor('SSE MinIO ready', () => dk('exec', C_SSE, 'mc', 'ready', 'local').status === 0);
    const r0 = run('docker', ['exec', '-i', '-e', 'U', '-e', 'S', C_SSE, 'sh', '-s'], {
      input: 'set -e; mc alias set r http://localhost:9000 "$U" "$S" >/dev/null; mc mb r/langfuse >/dev/null; echo secret > /tmp/s; mc cp -q --enc-s3 r/langfuse /tmp/s r/langfuse/encrypted.txt >/dev/null; echo plain > /tmp/p; mc cp -q /tmp/p r/langfuse/plain.txt >/dev/null; mc stat r/langfuse/encrypted.txt | grep -q SSE-S3',
      env: { U: OLD_CREDS.S3_ACCESS_KEY, S: OLD_CREDS.S3_SECRET_KEY },
    });
    assert.equal(r0.status, 0, `could not write a real SSE-S3 object: ${r0.stderr}`);
  } finally {
    dk('rm', '-f', C_SSE);
  }
  const r = tool(['inventory', '--volume', SSE_FIX, '--out', 'fix-sse.json']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const inv = json('fix-sse.json');
  assert.equal(inv.verdict, 'refused');
  assert.equal(inv.sseObjects, 1, 'exactly the one encrypted object');
  assert.equal(inv.control, inv.xlMetaFiles);
});

live('inventory REFUSES a bucket carrying a notification target, naming the bucket', () => {
  fixture(NOTIFY_FIX, [
    'mkdir -p /data/.minio.sys/buckets/langfuse/.metadata.bin /data/langfuse',
    `printf '%s' '{"version":"1","format":"xl-single","id":"x","xl":{"version":"3","this":"d","sets":[["d"]],"distributionAlgo":"SIPMOD+PARITY"}}' > /data/.minio.sys/format.json`,
    "printf 'XL2 NotificationConfigXML<NotificationConfiguration><QueueConfiguration><Queue>arn:minio:sqs::1:webhook</Queue></QueueConfiguration></NotificationConfiguration>' > /data/.minio.sys/buckets/langfuse/.metadata.bin/xl.meta",
  ].join(' && '));
  const r = tool(['inventory', '--volume', NOTIFY_FIX, '--out', 'fix-notify.json']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const inv = json('fix-notify.json');
  assert.equal(inv.verdict, 'refused');
  assert.match(inv.reasons.join(' '), /notification.*langfuse/);
});
