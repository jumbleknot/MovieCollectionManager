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
const KOMODO_PASSWORD = 'komodo-pw-s3cr3t';

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

/** A pg_dump custom-format (-Fc) file: the PGDMP magic, then `bytes` of (incompressible) body. */
function pgCustomDump(path, bytes, { magic = true } = {}) {
  sh(`{ ${magic ? "printf 'PGDMP'; " : ''}head -c ${bytes} /dev/urandom; } > "${path}"`);
  return path;
}

// What a restore cannot do without (R7); `forge-data`'s check fails on a listing that lacks any.
const FORGE_DATA_REQUIRED = ['git/repositories/jumbleknot/mcm.git/HEAD', 'gitea/conf/app.ini', 'gitea/jwt/private.pem'];

/**
 * A real, uncompressed tar of `/data`'s layout. The `bytes` of bulk sit in gitea/actions_log (the
 * real bulk, 447 M): kept, and never one of the required paths, so omitting one cannot trip the size
 * check before the content check.
 */
function forgeDataTar(path, bytes, { omit = [] } = {}) {
  const d = `${path}.src`;
  sh(`rm -rf "${d}" && mkdir -p "${d}/git/repositories/jumbleknot/mcm.git" "${d}/gitea/conf" "${d}/gitea/jwt" "${d}/gitea/actions_log"`);
  sh(`head -c ${bytes} /dev/urandom > "${d}/gitea/actions_log/run.log"`);
  for (const f of FORGE_DATA_REQUIRED.filter((p) => !omit.some((o) => p.startsWith(o)))) sh(`echo x > "${d}/${f}"`);
  for (const o of omit) sh(`rm -rf "${d}/${o}"`);
  sh(`tar -cf "${path}" -C "${d}" gitea git`);
  return path;
}

const APK_OWNER = 'jumbleknot';
const APK_VERSIONS = { '1.2.0': 'mcm-1.2.0.apk', '1.3.0': 'mcm-1.3.0.apk' };
const PACKAGE_TOKEN = 'pkg-token-s3cr3t-value';

/**
 * The generic-package API as the forge answers it: `q=` is a SUBSTRING match and pages hold 50, so
 * page 1 is 49 rows of another package plus one real version, and page 2 holds the other version
 * (the trap publish-apk.mjs documents: an unpaginated or unfiltered read silently misses versions).
 */
function packageFixtures(fx) {
  const versions = Object.keys(APK_VERSIONS);
  const row = (name, version) => ({ id: 1, owner: { login: APK_OWNER }, name, type: 'generic', version });
  const page1 = [...Array.from({ length: 49 }, (_, i) => row('mcm-app-android-symbols', `0.${i}.0`)), row('mcm-app-android', versions[0])];
  const fixtures = [
    { cmd: 'curl', match: [`/api/v1/packages/${APK_OWNER}?`, 'page=1&'], stdout: JSON.stringify(page1) },
    { cmd: 'curl', match: [`/api/v1/packages/${APK_OWNER}?`, 'page=2&'], stdout: JSON.stringify([row('mcm-app-android', versions[1])]) },
    { cmd: 'curl', match: [`/api/v1/packages/${APK_OWNER}?`], stdout: '[]' },
  ];
  for (const [v, file] of Object.entries(APK_VERSIONS)) {
    const apk = join(fx, file);
    sh(`head -c ${6 * MIB} /dev/urandom > "${apk}"`);
    fixtures.push(
      { cmd: 'curl', match: [`/api/v1/packages/${APK_OWNER}/generic/mcm-app-android/${v}/files`], stdout: JSON.stringify([{ id: 9, name: file, size: 6 * MIB }]) },
      { cmd: 'curl', match: [`/api/packages/${APK_OWNER}/generic/mcm-app-android/${v}/${file}`], stdoutFile: apk },
    );
  }
  return fixtures;
}

/**
 * A fake prod host whose dumps are all good, sized like the real ones (scaled down where the real
 * ones are gigabytes), plus whatever `overrides` replace. Returns the shim env and an alert log.
 */
function host({ overrides = [], keycloakBytes = 381023, extraFixtures = [], packageToken = PACKAGE_TOKEN, packageTokenMode = 0o600 } = {}) {
  // df is shimmed so the staging check sees a disk: the test's own HOME may sit on a tmpfs /tmp.
  const env = makeShimEnv({ shims: ['docker', 'restic', 'curl', 'systemctl', 'df'] });
  const fx = join(env.root, 'fx');
  mkdirSync(fx);
  const files = {
    forgeDb: pgCustomDump(join(fx, 'forge-db.dump'), 2 * MIB),
    forgeData: forgeDataTar(join(fx, 'forge-data.tar'), 11 * MIB),
    komodoGlobals: sqlDump(join(fx, 'komodo-globals.sql'), 4 * KIB, { cluster: true }),
    komodoDb: sqlDump(join(fx, 'komodo-db.sql'), 1 * MIB),
    keycloak: sqlDump(join(fx, 'keycloak.sql'), keycloakBytes),
    agentDb: sqlDump(join(fx, 'agent-db.sql'), 670),
    mcMongo: gzDump(join(fx, 'mc.gz'), 200 * KIB),
    bffMongo: gzDump(join(fx, 'bff.gz'), 3 * KIB),
  };
  const good = [
    { cmd: 'docker', match: ['forgejo-forgejo-db-1'], stdoutFile: files.forgeDb },
    { cmd: 'docker', match: ['forgejo-forgejo-1', 'tar'], stdoutFile: files.forgeData },
    { cmd: 'docker', match: ['komodo-postgres-1', 'pg_dumpall', '--globals-only'], stdoutFile: files.komodoGlobals },
    { cmd: 'docker', match: ['komodo-postgres-1', 'psql'], stdout: 'postgres\nkomodo\n' },
    { cmd: 'docker', match: ['komodo-postgres-1', 'pg_dump '], stdoutFile: files.komodoDb },
    ...packageFixtures(fx),
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
  writeFileSync(join(env.home, 'komodo/compose.env'), `KOMODO_DATABASE_USERNAME=k\nKOMODO_DATABASE_PASSWORD=${KOMODO_PASSWORD}\n`);
  writeFileSync(join(env.home, 'backup/alert.env'), 'MCM_FORGE_URL=http://forge.example:3000\n');
  if (packageToken !== null) {
    const t = join(env.home, 'backup/forge-package-token');
    writeFileSync(t, `${packageToken}\n`);
    chmodSync(t, packageTokenMode);
  }
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
  const tars = Object.fromEntries(Object.entries(call.tars ?? {})
    .filter(([p]) => dirname(p) === dir).map(([p, listing]) => [p.slice(dir.length + 1), listing]));
  return { dir, files: call.dirs[dir], manifest: call.manifests[dir] ?? '', tars };
};
const dockerCalls = (h) => h.env.calls().filter((c) => c.cmd === 'docker');

/** dump-manifest.tsv rows keyed by dump name; comment lines start with `#`. */
function manifestRows(text) {
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  const [header, ...rows] = lines.map((l) => l.split('\t'));
  assert.deepEqual(header, ['name', 'file', 'bytes', 'min_bytes', 'max_bytes', 'format', 'prev_bytes', 'verdict']);
  return Object.fromEntries(rows.map((r) => [r[0], Object.fromEntries(header.map((h, i) => [h, r[i]]))]));
}

// ── FR-003: one failing dump never skips the others ────────────────────────────────────────────

test('a failing forge dump does not skip the others — every dump runs and restic still uploads', () => {
  const h = host({ overrides: [{ cmd: 'docker', match: ['forgejo-forgejo-1', 'tar'], stderr: 'no space left on device', exit: 1 }] });
  const r = h.run();
  assert.equal(r.status, 1, 'a failed dump fails the unit, so OnFailure alerts');
  const dumped = dockerCalls(h).map((c) => c.argv.join(' '));
  for (const container of ['forgejo-forgejo-db-1', 'komodo-postgres-1', 'keycloak-store-postgres',
    'movie-assistant-store-postgres', 'mc-service-store-mongo', 'mcm-bff-store-mongo']) {
    assert.ok(dumped.some((a) => a.includes(container)), `${container} was never dumped`);
  }
  assert.ok(resticCall(h, 'forget'), 'retention must still run');
  const { files, manifest } = stagingOf(h);
  assert.ok('DUMP-FAILED-forge-data' in files, `no failure marker in ${Object.keys(files)}`);
  assert.equal(manifestRows(manifest)['forge-data'].verdict, 'failed-command');
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

test('each dump is checked in its own format: a forge data archive that does not list is failed-format', () => {
  const h = host();
  sh(`head -c ${11 * MIB} /dev/urandom > "${h.files.forgeData}"`);
  assert.equal(h.run().status, 1);
  assert.equal(manifestRows(stagingOf(h).manifest)['forge-data'].verdict, 'failed-format');
});

test('each dump is checked in its own format: a forge database dump without the PGDMP magic is failed-format', () => {
  const h = host();
  pgCustomDump(h.files.forgeDb, 2 * MIB, { magic: false });
  assert.equal(h.run().status, 1);
  assert.equal(manifestRows(stagingOf(h).manifest)['forge-db'].verdict, 'failed-format');
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
  const h = host({ overrides: [{ cmd: 'docker', match: ['forgejo-forgejo-1', 'tar'], exit: 1 }] });
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

// ── FR-017–FR-019a: the forge is a database dump plus an uncompressed data tar (R7) ───────────

// Everything under /data a restore can do without, and nothing else (R7's table classifies every
// directory the host has). Adding a path here is a decision about what a restore loses.
const FORGE_DATA_EXCLUDES = ['gitea/actions_artifacts', 'gitea/packages', 'gitea/repo-archive', 'gitea/indexers',
  'gitea/queues', 'gitea/tmp', 'gitea/log', 'gitea/sessions'];

/** The `tar …` argv of the forge-data dump, and its --exclude set normalised. */
function forgeDataTarCall(h) {
  const call = dockerCalls(h).find((c) => c.argv.includes('forgejo-forgejo-1') && c.argv.includes('tar'));
  assert.ok(call, `no tar ran in forgejo-forgejo-1: ${dockerCalls(h).map((c) => c.argv.join(' ')).join(' | ')}`);
  const tar = call.argv.slice(call.argv.indexOf('tar') + 1);
  const excludes = tar.flatMap((a, i) => (a.startsWith('--exclude=') ? [a.slice(10)] : a === '--exclude' ? [tar[i + 1]] : []))
    .map((p) => p.replace(/^\.\//, '').replace(/\/$/, ''));
  return { tar, excludes };
}

test('the forge is backed up as a database dump plus a data tar without diagnostics: forgejo dump is never called', () => {
  const h = host();
  const r = h.run();
  for (const c of dockerCalls(h)) assert.ok(!c.argv.join(' ').includes('forgejo dump'), c.argv.join(' '));
  assert.equal(r.status, 0, r.stderr);

  // forge-db: pg_dump's custom format, from the forge's own database container
  const db = dockerCalls(h).find((c) => c.argv.includes('forgejo-forgejo-db-1'));
  assert.ok(db, 'the forge database was never dumped');
  assert.match(db.argv.join(' '), /\bpg_dump\b.*-Fc\b/);
  const rows = manifestRows(stagingOf(h).manifest);
  assert.equal(rows['forge-db'].format, 'pg-custom');
  assert.equal(rows['forge-db'].verdict, 'ok');
  assert.equal(rows.forge, undefined, 'the old single forge dump is gone');

  // forge-data: an UNCOMPRESSED tar of /data, so restic de-duplicates it night to night (FR-019a)
  const { tar, excludes } = forgeDataTarCall(h);
  assert.ok(tar.join(' ').includes('-C /data'), `tar does not read /data: ${tar.join(' ')}`);
  for (const a of tar) assert.doesNotMatch(a, /^(-[a-zA-Z]*z[a-zA-Z]*|--gzip|--zstd|--xz|--bzip2|-[a-zA-Z]*[jJ][a-zA-Z]*)$/, `compressed tar flag ${a}`);
  assert.deepEqual([...excludes].sort(), [...FORGE_DATA_EXCLUDES].sort());
  assert.equal(rows['forge-data'].format, 'tar');
  assert.equal(rows['forge-data'].verdict, 'ok');
  const runDumpLine = SOURCE.split('\n').findIndex((l) => /run_dump forge-data\b/.test(l));
  assert.ok(runDumpLine >= 0, 'no run_dump forge-data line');
  assert.doesNotMatch(SOURCE.split('\n').slice(runDumpLine, runDumpLine + 6).join('\n'), /\|\s*(gzip|pigz|zstd)/,
    'no compression pipe after the tar');
});

test('the forge is backed up as a database dump plus a data tar without diagnostics: a listing without what a restore needs is failed-format', () => {
  for (const missing of ['git/repositories', 'gitea/conf/app.ini', 'gitea/jwt']) {
    const h = host();
    forgeDataTar(h.files.forgeData, 11 * MIB, { omit: [missing] });
    assert.equal(h.run().status, 1, `a forge-data tar without ${missing} must fail the run`);
    assert.equal(manifestRows(stagingOf(h).manifest)['forge-data'].verdict, 'failed-format', missing);
  }
});

test('the forge is backed up as a database dump plus a data tar without diagnostics: each half is its own dump to ack', () => {
  for (const name of ['forge-db', 'forge-data', 'release-apks']) assert.equal(host().run(['--ack-shrink', name]).status, 0, name);
  assert.equal(host().run(['--ack-shrink', 'forge']).status, 2, 'the old name is no longer a dump');
});

// ── FR-019d: Komodo's dump excludes pg_cron's run history (R8) ──────────────────────────────────

const komodoCalls = (h) => dockerCalls(h).filter((c) => c.argv.includes('komodo-postgres-1'));

test("Komodo's dump excludes its scheduler history: globals from pg_dumpall, each database from pg_dump without cron.job_run_details", () => {
  const h = host();
  const r = h.run();
  const all = komodoCalls(h);
  const dumpalls = all.filter((c) => c.argv.includes('pg_dumpall'));
  assert.ok(dumpalls.length > 0, 'roles come from pg_dumpall --globals-only');
  for (const c of dumpalls) assert.ok(c.argv.includes('--globals-only'), `pg_dumpall without --globals-only: ${c.argv.join(' ')}`);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(all.some((c) => c.argv.includes('psql')), 'the databases are listed, not hard-coded');
  for (const db of ['postgres', 'komodo']) {
    const c = all.find((x) => x.argv.includes('pg_dump') && x.argv.includes(db));
    assert.ok(c, `database ${db} was never dumped`);
    assert.match(c.argv.join(' '), /--exclude-table-data[= ]cron\.job_run_details\b/, `${db}: ${c.argv.join(' ')}`);
  }
  const row = manifestRows(stagingOf(h).manifest).komodo;
  assert.equal(row.max_bytes, '500000000');
  assert.equal(row.format, 'pg-plain');
  assert.equal(row.verdict, 'ok');
  assert.ok(!h.env.rawCalls().includes(KOMODO_PASSWORD), 'the Komodo password reaches docker by env name, never in argv');
});

test("Komodo's dump excludes its scheduler history: over 500 MB is warn-max, alerts komodo-oversize, and still uploads", () => {
  const h = host();
  const huge = join(h.fx, 'komodo-huge.sql');
  sh(`truncate -s 600000000 "${huge}" && printf '\\n--\\n-- PostgreSQL database dump complete\\n--\\n\\n' >> "${huge}"`);
  h.env.setFixtures([{ cmd: 'docker', match: ['komodo-postgres-1', 'pg_dump ', ' -d komodo'], stdoutFile: huge },
    ...JSON.parse(readFileSync(h.env.env.SHIM_FIXTURES, 'utf8'))]);
  const r = h.run();
  assert.equal(r.status, 0, `an oversize dump alerts; it does not fail the unit: ${r.stderr}`);
  assert.equal(manifestRows(stagingOf(h).manifest).komodo.verdict, 'warn-max');
  assert.match(h.alerts(), /ALERT komodo-oversize/);
  assert.doesNotMatch(h.alerts(), /ALERT recovered/, 'recovered would close the item the oversize alert just opened');
});

test("Komodo's dump excludes its scheduler history: a failing database dump says why (stderr is not discarded)", () => {
  const h = host({ overrides: [{ cmd: 'docker', match: ['komodo-postgres-1', 'pg_dump ', ' -d komodo'], stderr: 'pg_dump: error: query failed: out of memory\n', exit: 1 }] });
  const r = h.run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pg_dump: error: query failed: out of memory/);
  assert.equal(manifestRows(stagingOf(h).manifest).komodo.verdict, 'failed-command');
  const body = SOURCE.match(/^dump_komodo\(\) \{[\s\S]*?^\}/m);
  assert.ok(body, 'no dump_komodo function');
  assert.doesNotMatch(body[0], /\/dev\/null/);
});

// ── R10: release APKs, the one registry artefact a rebuild cannot reproduce ─────────────────────

const apkDownloads = (h) => h.env.calls().filter((c) => c.cmd === 'curl' && c.argv.some((a) => a.includes('/api/packages/')));

test('release APKs are dumped from the package API: every version, every file, into release-apks/<version>/', () => {
  const h = host();
  const r = h.run();
  const { dir, manifest, tars } = stagingOf(h);
  const row = manifestRows(manifest)['release-apks'];
  assert.ok(row, 'no release-apks row in the manifest');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(row.format, 'tar');
  assert.equal(row.verdict, 'ok');
  const listing = (tars[row.file] ?? []).map((p) => p.replace(/^\.\//, ''));
  for (const [v, file] of Object.entries(APK_VERSIONS)) {
    assert.ok(listing.includes(`release-apks/${v}/${file}`), `release-apks/${v}/${file} not in ${row.file}: ${listing}`);
  }
  assert.equal(apkDownloads(h).length, Object.keys(APK_VERSIONS).length, 'one download per file');
  // q= is a substring match: page 1's 49 mcm-app-android-symbols rows must never be fetched.
  const fetched = new Set(h.env.calls().filter((c) => c.cmd === 'curl')
    .flatMap((c) => c.argv.map((a) => a.match(/\/generic\/mcm-app-android\/([^/]+)\//)?.[1]).filter(Boolean)));
  assert.deepEqual([...fetched].sort(), Object.keys(APK_VERSIONS).sort(), 'only mcm-app-android versions are fetched');
  assert.deepEqual(listing.filter((p) => /^release-apks\/[^/]+\/?$/.test(p)).map((p) => p.replace(/\/$/, '')).sort(),
    Object.keys(APK_VERSIONS).map((v) => `release-apks/${v}`).sort());

  for (const c of h.env.calls().filter((x) => x.cmd === 'curl')) {
    const url = c.argv.find((a) => /^https?:\/\//.test(a));
    assert.ok(url?.startsWith('http://forge.example:3000/'), `the forge URL comes from MCM_FORGE_URL: ${url}`);
    const header = c.argv[c.argv.indexOf('-H') + 1];
    assert.ok(header?.startsWith('@'), `the token travels in a header FILE: ${c.argv.join(' ')}`);
    assert.ok(!header.slice(1).startsWith(dir), 'the header file is never staged: it would be uploaded');
  }
  assert.ok(!h.env.rawCalls().includes(PACKAGE_TOKEN), 'the token never appears in argv');
});

test('release APKs are dumped from the package API: a version whose file list is unreadable fails the dump, not skipped', () => {
  const h = host({ overrides: [{ cmd: 'curl', match: ['/generic/mcm-app-android/1.3.0/files'], stdout: '<html>502</html>' }] });
  assert.equal(h.run().status, 1);
  const { files, manifest } = stagingOf(h);
  assert.ok('DUMP-FAILED-release-apks' in files);
  assert.equal(manifestRows(manifest)['release-apks'].verdict, 'failed-command');
});

test('release APKs are dumped from the package API: a missing or loose token file fails that dump only', () => {
  for (const opts of [{ packageToken: null }, { packageTokenMode: 0o644 }]) {
    const h = host(opts);
    const r = h.run();
    assert.equal(r.status, 1, `${JSON.stringify(opts)}: the unit fails, so OnFailure alerts`);
    assert.match(r.stderr, /forge-package-token/);
    assert.deepEqual(apkDownloads(h), [], 'nothing is downloaded without the token');
    const { files, manifest } = stagingOf(h);
    assert.ok('DUMP-FAILED-release-apks' in files);
    const rows = manifestRows(manifest);
    for (const name of ['forge-db', 'forge-data', 'komodo', 'keycloak', 'agent-db', 'mc-service-mongo', 'bff-mongo']) {
      assert.equal(rows[name]?.verdict, 'ok', `${name} must still be dumped`);
    }
    assert.ok(resticCall(h, 'forget'), 'retention must still run');
  }
});
