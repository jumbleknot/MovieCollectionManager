// Guard: every RustFS service in a git-tracked compose file keeps the contract of feature 080
// (specs/080-minio-to-rustfs/contracts/object-store-service.md, S1–S9).
//
// Each clause is here because the obvious alternative was measured to fail (research.md):
//
//   S1  digest-pinned, the Alpine tag, ONE digest everywhere — Renovate moves them together, and a
//       floating tag is how the old Nx-cache MinIO froze at whatever quay last received (R14).
//   S2  NO `user:` key. A fresh named volume inherits the image's /data (uid 10001, 0750); any other
//       uid is FATAL at startup — and CI's backup destination is a fresh volume on every run (R5).
//   S3  RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY, the secret fail-fast `${VAR:?…}`. The image's own
//       answer to a MISSING credential is a warning and the well-known default `rustfsadmin` (R4).
//   S4  a real readiness probe, RustFS's own path, so nothing keeps a MinIO-compat shim alive (R7).
//   S5  bucket init with credentials referenced as `$$VAR` from the container's environment and fed
//       to curl on stdin — never `${…}` interpolated into argv, where `docker inspect` and `ps` read
//       it (the defect fixed in 56983c75). Prod keeps the "stay alive, healthy on a marker" shape
//       because Komodo counts an exited container as unhealthy.
//   S6  logs to stdout. The image default writes a FILE that docker logs never sees (R9).
//   S7  console off and no console port: RustFS's console defaults to ON with CORS `*` (R10, and
//       T011 measured that RUSTFS_CONSOLE_ENABLE=false closes :9001).
//   S8  prod `restart: always`.
//   S9  the prod data volume is EXTERNAL and created only by the migration tool, so a deploy that
//       runs before the copy fails on a missing volume instead of starting Langfuse on an empty store.
//
// INSTRUMENT CHECK: it asserts it found at least one RustFS server in each of the three files. A
// guard that passes because it matched nothing is the failure mode CLAUDE.md warns about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import { pinnedRustfsRef } from '../object-store-migration.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const FILES = {
  'observability/compose.yaml': { prod: false, server: 'langfuse-rustfs', init: 'langfuse-rustfs-init', ports: [] },
  'observability/compose.prod.yaml': { prod: true, server: 'langfuse-rustfs', init: 'langfuse-rustfs-init', ports: [] },
  'backups/compose.yaml': { prod: false, server: 'mcm-bff-backup-rustfs', init: 'mcm-bff-backup-rustfs-init', ports: ['127.0.0.1:9100:9000'] },
};

const S4 = ['CMD', 'curl', '-fsS', '-o', '/dev/null', 'http://localhost:9000/health/ready'];
const IMAGE_RE = /^rustfs\/rustfs:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/;
const FAILFAST_RE = /^\$\{[A-Z0-9_]+:\?[^}]+\}$/;

const load = (rel) => {
  const text = readFileSync(resolve(REPO_ROOT, 'infrastructure-as-code/docker', rel), 'utf8');
  return { text, doc: parseYaml(text) };
};
const rustfsServices = (doc) =>
  Object.entries(doc.services ?? {}).filter(([, s]) => /(^|\/)rustfs\/rustfs[:@]/.test(String(s.image ?? '')));
const argvText = (s) => [s.entrypoint, s.command].flat().filter((x) => x !== undefined).join(' ');
const env = (s) => (Array.isArray(s.environment)
  ? Object.fromEntries(s.environment.map((e) => [e.split('=')[0], e.split('=').slice(1).join('=')]))
  : (s.environment ?? {}));

for (const [rel, spec] of Object.entries(FILES)) {
  test(`${rel}: the instrument found the RustFS server and its init (S1)`, () => {
    const names = rustfsServices(load(rel).doc).map(([n]) => n).sort();
    assert.deepEqual(names, [spec.server, spec.init].sort(), `RustFS services in ${rel}`);
  });

  test(`${rel}: every RustFS image is the digest-pinned Alpine tag (S1)`, () => {
    for (const [name, s] of rustfsServices(load(rel).doc)) {
      assert.match(s.image, IMAGE_RE, `${name}: ${s.image}`);
      assert.doesNotMatch(s.image, /glibc|latest/, name);
    }
  });

  test(`${rel}: no RustFS service overrides the runtime user (S2)`, () => {
    for (const [name, s] of rustfsServices(load(rel).doc)) {
      assert.equal(s.user, undefined, `${name} declares user: ${s.user} — a fresh volume then fails with Permission denied`);
    }
  });

  test(`${rel}: the server has RUSTFS_* credentials, fail-fast secret, no MINIO_* alias (S3)`, () => {
    const s = load(rel).doc.services[spec.server];
    const e = env(s);
    assert.ok(e.RUSTFS_ACCESS_KEY, 'RUSTFS_ACCESS_KEY unset — the image would fall back to rustfsadmin');
    assert.match(String(e.RUSTFS_SECRET_KEY), FAILFAST_RE, 'RUSTFS_SECRET_KEY must be ${VAR:?…}');
    assert.deepEqual(Object.keys(e).filter((k) => /^MINIO_/i.test(k)), []);
  });

  test(`${rel}: the server healthcheck is the S4 readiness probe (S4)`, () => {
    const h = load(rel).doc.services[spec.server].healthcheck;
    assert.deepEqual(h?.test, S4);
    assert.equal(h.interval, '10s');
    assert.equal(h.timeout, '5s');
    assert.equal(h.retries, 10);
    assert.equal(h.start_period, '20s');
  });

  test(`${rel}: every dependant waits for the server to be HEALTHY (S4)`, () => {
    const { doc } = load(rel);
    let found = 0;
    for (const [name, s] of Object.entries(doc.services)) {
      const dep = s.depends_on?.[spec.server];
      if (!dep) continue;
      found++;
      assert.equal(dep.condition, 'service_healthy', `${name} depends on ${spec.server} without service_healthy`);
    }
    assert.ok(found >= 1, `nothing depends on ${spec.server}`);
  });

  test(`${rel}: bucket init reads credentials from its environment, never argv (S5)`, () => {
    const s = load(rel).doc.services[spec.init];
    const argv = argvText(s);
    assert.doesNotMatch(argv, /\$\{/, `${spec.init}: \${…} interpolated into entrypoint/command puts the value in argv`);
    assert.match(argv, /\$\$S3_SECRET_KEY/, 'the secret must be referenced as $$S3_SECRET_KEY');
    assert.match(argv, /curl -fsS -K -/, 'credentials go to curl as a config on stdin');
    assert.match(argv, /--aws-sigv4/);
    assert.match(String(env(s).S3_SECRET_KEY), FAILFAST_RE);
    assert.equal(s.depends_on?.[spec.server]?.condition, 'service_healthy');
  });

  test(`${rel}: bucket init has the ${spec.prod ? 'prod stay-alive' : 'one-shot'} shape (S5)`, () => {
    const { doc } = load(rel);
    const s = doc.services[spec.init];
    const argv = argvText(s);
    const dependants = Object.entries(doc.services).filter(([, x]) => x.depends_on?.[spec.init]);
    if (spec.prod) {
      assert.match(argv, /touch \/tmp\/ready/);
      assert.match(argv, /exec sleep infinity/);
      assert.deepEqual(s.healthcheck?.test, ['CMD-SHELL', 'test -f /tmp/ready']);
      assert.ok(dependants.length >= 1, 'nothing waits for the prod init');
      for (const [n, x] of dependants) assert.equal(x.depends_on[spec.init].condition, 'service_healthy', n);
    } else {
      assert.doesNotMatch(argv, /sleep infinity/);
      assert.equal(s.restart, undefined, 'a one-shot must not restart');
      for (const [n, x] of dependants) assert.equal(x.depends_on[spec.init].condition, 'service_completed_successfully', n);
    }
  });

  test(`${rel}: logs go to stdout and the console is off (S6, S7)`, () => {
    const e = env(load(rel).doc.services[spec.server]);
    assert.equal(e.RUSTFS_OBS_LOG_DIRECTORY, '', 'RUSTFS_OBS_LOG_DIRECTORY must be "" (stdout)');
    assert.equal(String(e.RUSTFS_CONSOLE_ENABLE), 'false');
  });

  test(`${rel}: ports are exactly ${JSON.stringify(spec.ports)} — no console port (S7)`, () => {
    for (const [name, s] of rustfsServices(load(rel).doc)) {
      const ports = (s.ports ?? []).map(String);
      assert.ok(!ports.some((p) => /:9001$|^9001$/.test(p)), `${name} publishes the console port`);
      if (name === spec.server) assert.deepEqual(ports, spec.ports);
      else assert.deepEqual(ports, []);
    }
  });

  if (spec.prod) {
    test(`${rel}: prod RustFS services restart always (S8)`, () => {
      for (const [name, s] of rustfsServices(load(rel).doc)) assert.equal(s.restart, 'always', name);
    });

    test(`${rel}: the data volume is EXTERNAL observability-langfuse-rustfs-data (S9)`, () => {
      const { doc } = load(rel);
      const mount = doc.services[spec.server].volumes.find((v) => String(v).endsWith(':/data'));
      const key = String(mount).split(':')[0];
      assert.deepEqual(doc.volumes[key], { external: true, name: 'observability-langfuse-rustfs-data' });
    });
  }
}

test('every RustFS service in all three files pins the SAME image (S1)', () => {
  const refs = new Set();
  for (const rel of Object.keys(FILES)) for (const [, s] of rustfsServices(load(rel).doc)) refs.add(s.image);
  assert.equal(refs.size, 1, [...refs].join('\n'));
});

test('the migration tool resolves its default image from the REAL production compose', () => {
  const { text } = load('observability/compose.prod.yaml');
  assert.match(pinnedRustfsRef(text), IMAGE_RE);
});
