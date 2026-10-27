// infrastructure-as-code/backup/backup.sh — the prod host's nightly backup (spec 084 US1/US4).
//
// It failed every night from 2026-07-27 to 2026-10-22 and nobody was told. Three defects made that
// possible and each is pinned here by RUNNING the script against a fake host (host-shims.mjs):
//   - the forge dump was the one step with no fallback, so under `set -e` its failure skipped every
//     database dump and the off-site upload (FR-003);
//   - a dump that "succeeded" but was empty, truncated or far smaller than last night's was
//     uploaded as if good (FR-003a, FR-003b);
//   - the measured failure modes — RAM-backed staging, path-grouped retention that never pruned —
//     had no guard, because the script lived only on the host (FR-004).
//
// Unit tier: docker/restic/curl are shims; tar, gzip and python3 are real, so the format checks
// run against real files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeShimEnv } from './host-shims.mjs';
import { scanText } from '../secret-scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(REPO_ROOT, 'infrastructure-as-code/backup/backup.sh');
const SOURCE = readFileSync(SCRIPT, 'utf8');

const KIB = 1024;
const MIB = 1024 * KIB;

const sh = (cmd) => {
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

/** A plain-SQL dump of `bytes`, ending the way pg_dump (or pg_dumpall, `cluster: true`) ends. */
function sqlDump(path, bytes, { trailer = true, cluster = false } = {}) {
  const end = trailer ? `--\n-- PostgreSQL database ${cluster ? 'cluster ' : ''}dump complete\n--\n\n` : '';
  const pad = Math.max(0, bytes - end.length);
  writeFileSync(path, `${'-- pad\n'.repeat(Math.ceil(pad / 7)).slice(0, pad)}${end}`);
  return path;
}

/** A real gzip stream of roughly `bytes` (random content does not compress). */
function gzDump(path, bytes) {
  sh(`head -c ${bytes} /dev/urandom | gzip -1 > "${path}"`);
  return path;
}

/** A real .tar.gz of roughly `bytes`, holding the paths a forge dump holds. */
function tarGzDump(path, bytes) {
  const d = `${path}.src`;
  sh(`mkdir -p "${d}/repos" && head -c ${bytes} /dev/urandom > "${d}/repos/blob" && echo x > "${d}/app.ini"`);
  sh(`tar -czf "${path}" -C "${d}" .`);
  return path;
}

/**
 * A fake prod host whose dumps are all good, sized like the real ones (scaled down where the real
 * ones are gigabytes), plus whatever `overrides` replace. Returns the shim env and an alert log.
 */
function host({ overrides = [], keycloakBytes = 381023, extraFixtures = [] } = {}) {
  // df is shimmed so the staging check sees a disk: the test's own HOME may sit on a tmpfs /tmp.
  const env = makeShimEnv({ shims: ['docker', 'restic', 'curl', 'systemctl', 'df'] });
  const fx = join(env.root, 'fx');
  mkdirSync(fx);
  const files = {
    forge: tarGzDump(join(fx, 'forge.tar.gz'), 11 * MIB),
    komodo: sqlDump(join(fx, 'komodo.sql'), 2 * MIB, { cluster: true }),
    keycloak: sqlDump(join(fx, 'keycloak.sql'), keycloakBytes),
    agentDb: sqlDump(join(fx, 'agent-db.sql'), 670),
    mcMongo: gzDump(join(fx, 'mc.gz'), 200 * KIB),
    bffMongo: gzDump(join(fx, 'bff.gz'), 3 * KIB),
  };
  const good = [
    { cmd: 'docker', match: ['forgejo dump'], stdoutFile: files.forge },
    { cmd: 'docker', match: ['komodo-postgres-1'], stdoutFile: files.komodo },
    { cmd: 'docker', match: ['keycloak-store-postgres'], stdoutFile: files.keycloak },
    { cmd: 'docker', match: ['movie-assistant-store-postgres'], stdoutFile: files.agentDb },
    { cmd: 'docker', match: ['mc-service-store-mongo'], stdoutFile: files.mcMongo },
    { cmd: 'docker', match: ['mcm-bff-store-mongo'], stdoutFile: files.bffMongo },
    {
      cmd: 'docker',
      match: ['inspect'],
      stdout: 'MC_DB_URL=mongodb://u:p@mc-service-store-mongo:27017/mc\nMONGO_URL=mongodb://u:p@mcm-bff-store-mongo:27017/bff\n',
    },
    { cmd: 'df', stdout: 'Type\next4\n' },
  ];
  env.setFixtures([...overrides, ...extraFixtures, ...good]);

  mkdirSync(join(env.home, 'komodo'), { recursive: true });
  writeFileSync(join(env.home, 'komodo/compose.env'), 'KOMODO_DATABASE_USERNAME=k\nKOMODO_DATABASE_PASSWORD=pw\n');
  const alertLog = join(env.home, 'alerts.log');
  const stub = join(env.home, 'backup/backup-alert.sh');
  writeFileSync(stub, `#!/usr/bin/env bash\n{ echo "ALERT $1"; [ -n "\${2:-}" ] && [ -f "$2" ] && cat "$2"; } >> "${alertLog}"\n`);
  chmodSync(stub, 0o755);
  return {
    env,
    fx,
    files,
    alerts: () => (existsSync(alertLog) ? readFileSync(alertLog, 'utf8') : ''),
    run: (args = []) => env.run(SCRIPT, args),
  };
}

const resticCall = (h, sub) => h.env.calls().find((c) => c.cmd === 'restic' && c.argv[0] === sub);
const stagingOf = (h) => {
  const call = resticCall(h, 'backup');
  assert.ok(call, 'restic backup was never called');
  const dir = Object.keys(call.dirs).find((d) => /\/backup\/stage\.[^/]+$/.test(d));
  assert.ok(dir, `no staging dir among restic's arguments: ${call.argv.join(' ')}`);
  return { files: call.dirs[dir], manifest: call.manifests[dir] ?? '' };
};

/** dump-manifest.tsv rows keyed by dump name; comment lines start with `#`. */
function manifestRows(text) {
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  const [header, ...rows] = lines.map((l) => l.split('\t'));
  assert.deepEqual(header, ['name', 'file', 'bytes', 'min_bytes', 'max_bytes', 'format', 'prev_bytes', 'verdict']);
  return Object.fromEntries(rows.map((r) => [r[0], Object.fromEntries(header.map((h, i) => [h, r[i]]))]));
}

// ── FR-003: one failing dump never skips the others ────────────────────────────────────────────

test('a failing forge dump does not skip the others — every dump runs and restic still uploads', () => {
  const h = host({ overrides: [{ cmd: 'docker', match: ['forgejo dump'], stderr: 'no space left on device', exit: 1 }] });
  const r = h.run();
  assert.equal(r.status, 1, 'a failed dump fails the unit, so OnFailure alerts');
  const dumped = h.env.calls().filter((c) => c.cmd === 'docker').map((c) => c.argv.join(' '));
  for (const container of ['komodo-postgres-1', 'keycloak-store-postgres', 'movie-assistant-store-postgres',
    'mc-service-store-mongo', 'mcm-bff-store-mongo']) {
    assert.ok(dumped.some((a) => a.includes(container)), `${container} was never dumped`);
  }
  assert.ok(resticCall(h, 'forget'), 'retention must still run');
  const { files, manifest } = stagingOf(h);
  assert.ok('DUMP-FAILED-forge' in files, `no failure marker in ${Object.keys(files)}`);
  assert.equal(manifestRows(manifest).forge.verdict, 'failed-command');
});

// ── FR-003a: each dump is checked in its own format, and against a minimum ─────────────────────

test('each dump is checked in its own format: plain SQL without its end marker is failed-format', () => {
  const h = host();
  sqlDump(h.files.keycloak, 381023, { trailer: false });
  assert.equal(h.run().status, 1);
  const { files, manifest } = stagingOf(h);
  assert.equal(manifestRows(manifest).keycloak.verdict, 'failed-format');
  assert.ok('DUMP-FAILED-keycloak' in files);
});

test('each dump is checked in its own format: a truncated gzip is failed-format', () => {
  const h = host();
  sh(`truncate -s 150000 "${h.files.mcMongo}"`); // above the 100 KiB minimum: the FORMAT check must catch it
  assert.equal(h.run().status, 1);
  const { manifest } = stagingOf(h);
  assert.equal(manifestRows(manifest)['mc-service-mongo'].verdict, 'failed-format');
});

test('each dump is checked in its own format: a forge archive that does not list is failed-format', () => {
  const h = host();
  sh(`head -c ${11 * MIB} /dev/urandom > "${h.files.forge}"`);
  assert.equal(h.run().status, 1);
  assert.equal(manifestRows(stagingOf(h).manifest).forge.verdict, 'failed-format');
});

test('each dump is checked in its own format: an empty Keycloak dump is failed-min', () => {
  const h = host();
  writeFileSync(h.files.keycloak, '');
  assert.equal(h.run().status, 1);
  const rows = manifestRows(stagingOf(h).manifest);
  assert.equal(rows.keycloak.verdict, 'failed-min');
  assert.equal(rows.keycloak.bytes, '0');
});

test('each dump is checked in its own format: a 670-byte agent-db dump is ok (empty by design)', () => {
  const h = host();
  const r = h.run();
  assert.equal(r.status, 0, r.stderr);
  const rows = manifestRows(stagingOf(h).manifest);
  assert.equal(rows['agent-db'].verdict, 'ok');
  assert.equal(rows['agent-db'].min_bytes, '1');
  for (const [name, row] of Object.entries(rows)) assert.equal(row.verdict, 'ok', `${name}: ${row.verdict}`);
});

// ── FR-003b: shrink against the last good run ───────────────────────────────────────────────

const MANIFEST_HEADER = 'name\tfile\tbytes\tmin_bytes\tmax_bytes\tformat\tprev_bytes\tverdict\n';
const seedLastGood = (h, rows) => writeFileSync(join(h.env.home, 'backup/state/last-good.tsv'),
  MANIFEST_HEADER + rows.map(([n, b]) => `${n}\t-\t${b}\t-\t-\t-\t-\tok\n`).join(''));

test('shrink against the last good run: under half alerts with both sizes, and still uploads', () => {
  const h = host({ keycloakBytes: 100000 });
  seedLastGood(h, [['keycloak', 381023]]);
  const r = h.run();
  assert.equal(r.status, 0, 'a shrink alerts; it does not fail the unit');
  assert.equal(manifestRows(stagingOf(h).manifest).keycloak.verdict, 'alert-shrink');
  assert.match(h.alerts(), /ALERT shrink/);
  assert.match(h.alerts(), /keycloak 381023 → 100000/);
});

test('shrink against the last good run: an acknowledged shrink is not alerted, and the ack is spent', () => {
  const h = host({ keycloakBytes: 100000 });
  seedLastGood(h, [['keycloak', 381023]]);
  const ack = join(h.env.home, 'backup/state/ack-shrink-keycloak');
  writeFileSync(ack, '');
  assert.equal(h.run().status, 0);
  assert.equal(manifestRows(stagingOf(h).manifest).keycloak.verdict, 'ack-shrink');
  assert.doesNotMatch(h.alerts(), /ALERT shrink/);
  assert.equal(existsSync(ack), false, 'an ack covers one run only');
});

test('shrink against the last good run: with no previous manifest the comparison is skipped, and says so', () => {
  const h = host();
  assert.equal(h.run().status, 0);
  assert.match(stagingOf(h).manifest, /^# compare=skipped \(no previous manifest\)$/m);
});

test('shrink against the last good run: only a fully ok run rewrites last-good.tsv', () => {
  const h = host({ overrides: [{ cmd: 'docker', match: ['forgejo dump'], exit: 1 }] });
  const lastGood = join(h.env.home, 'backup/state/last-good.tsv');
  seedLastGood(h, [['keycloak', 381023]]);
  const before = readFileSync(lastGood, 'utf8');
  assert.equal(h.run().status, 1);
  assert.equal(readFileSync(lastGood, 'utf8'), before, 'a failed run must not become the baseline');

  const ok = host();
  assert.equal(ok.run().status, 0);
  const written = manifestRows(readFileSync(join(ok.env.home, 'backup/state/last-good.tsv'), 'utf8'));
  assert.equal(written.keycloak.bytes, '381023');
});

test('shrink against the last good run: a fully ok run reports recovered (the alert script no-ops if nothing is open)', () => {
  const h = host();
  assert.equal(h.run().status, 0);
  assert.match(h.alerts(), /ALERT recovered/);
});

test('shrink against the last good run: --ack-shrink writes the ack and dumps nothing; an unknown dump is refused', () => {
  const h = host();
  let r = h.run(['--ack-shrink', 'keycloak']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(h.env.home, 'backup/state/ack-shrink-keycloak')));
  r = h.run(['--ack-shrink', 'nope']);
  assert.equal(r.status, 2);
  assert.deepEqual(h.env.calls(), [], 'acknowledging must never run a backup');
});

// ── FR-004: the measured failure modes stay fixed ────────────────────────────────────────────

test('measured failure modes: staging is on disk under ~/backup, and --check-staging refuses tmpfs', () => {
  assert.match(SOURCE, /mktemp -d "\$HOME\/backup\/stage\.XXXXXX"/);
  // Code only: the staging line's own comment names /tmp, as the thing it must not be.
  for (const code of SOURCE.split('\n').filter((l) => l.includes('mktemp')).map((l) => l.split(' #')[0])) {
    assert.doesNotMatch(code, /\/tmp|\/dev\/shm|XDG_RUNTIME_DIR/, code);
  }
  for (const [fs, status] of [['tmpfs', 1], ['ext4', 0]]) {
    const h = host({ extraFixtures: [{ cmd: 'df', stdout: `Type\n${fs}\n` }] });
    const r = h.run(['--check-staging']);
    assert.equal(r.status, status, `${fs}: ${r.stdout}${r.stderr}`);
    assert.ok(!h.env.calls().some((c) => c.cmd === 'docker' || c.cmd === 'restic'), 'a check must not back up');
  }
});

test('measured failure modes: a nightly run whose staging is on tmpfs fails before dumping anything', () => {
  const h = host({ extraFixtures: [{ cmd: 'df', stdout: 'Type\ntmpfs\n' }] });
  const r = h.run();
  assert.equal(r.status, 1, 'the unit fails, so OnFailure alerts');
  assert.match(r.stderr, /tmpfs/);
  assert.ok(!h.env.calls().some((c) => c.cmd === 'docker'), 'no dump may be staged in RAM');
});

test('measured failure modes: retention groups by tag, never by the randomised staging path', () => {
  const forgets = SOURCE.split('\n').filter((l) => /^\s*restic forget/.test(l));
  assert.ok(forgets.length > 0);
  for (const l of forgets) {
    assert.match(l, /--tag homelab/);
    assert.match(l, /--group-by host,tags/);
  }
});

test('measured failure modes: the script holds no secret (credentials are read live)', () => {
  assert.deepEqual(scanText('infrastructure-as-code/backup/backup.sh', SOURCE), []);
  // A credential-named variable may only ever be assigned an expansion ($…), never a literal.
  // Names, not values: `kpass=`, `PGPASSWORD=`, `RESTIC_PASSWORD_FILE=` all qualify.
  const literal = /\b\w*(PASS|TOKEN|SECRET|KEY)\w*=(?!['"]?\$)['"]?[^\s'"]/i;
  assert.doesNotMatch(SOURCE, literal, 'no credential assigned a literal');
});

test('measured failure modes: an unknown argument is rejected before anything runs', () => {
  for (const args of [['--dry-run'], ['--help-me'], ['x'], ['--ack-shrink']]) {
    const h = host();
    const r = h.run(args);
    assert.equal(r.status, 2, `args ${JSON.stringify(args)} must exit 2, got ${r.status}`);
    assert.match(r.stderr, /usage/);
    assert.deepEqual(h.env.calls(), [], `args ${JSON.stringify(args)} must not touch docker or restic`);
  }
});
