// Spec 084 US5 / item #863 — the package registry keeps what is needed, and nothing else.
//
// The forge's container registry held 109 G on 2026-10-27 and nothing ever deleted from it: every
// CI push of the six app images, and of the dev-container image, is still there. Retention is a
// repository script, report-only by default, whose protections are computed from git BEFORE any API
// call — the forge's own cleanup rules match names by regex and cannot protect a digest named in a
// git file (research R13).
//
// THE MEASURED HAZARD THE DECISIONS ARE BUILT AROUND (0g, 2026-10-31). One push creates TWO versions:
// the tag `<sha>`, whose manifest.json IS the digest `.env.deploy` pins (an OCI image INDEX), and the
// `sha256:<digest>` children that index references (the platform manifest, which owns the layers,
// and an attestation). An index whose image did not change REUSES the previous push's platform
// manifest — so a child can be OLDER than the tag that needs it, and "delete what is old" deletes
// the layers of the image that is deployed. A child is therefore never judged by age alone: it is
// kept while any kept index references it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

import {
  loadConfig, ConfigError, protectedDigests, decide, main, CONFIG_PATH, bundlePublishingJobs,
} from '../registry-retention.mjs';
import { DEFAULT_DURATION_RUNS } from '../ci-status.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const SLICE = JSON.parse(readFileSync(join(HERE, 'fixtures/registry-retention/mc-service-slice.json'), 'utf8'));
const WORKFLOWS = resolve(REPO_ROOT, '.forgejo/workflows');
const NOW = Date.parse('2026-10-31T12:00:00Z');

/** Jobs that publish a ci-failures bundle, counted from the workflows themselves. */
function countBundleJobs() {
  let n = 0;
  for (const f of readdirSync(WORKFLOWS).filter((x) => /\.ya?ml$/.test(x))) {
    const wf = parseYaml(readFileSync(join(WORKFLOWS, f), 'utf8'));
    for (const job of Object.values(wf?.jobs ?? {})) {
      if ((job.steps ?? []).some((s) => /node scripts\/ci-failure-digest\.mjs/.test(s.run ?? ''))) n += 1;
    }
  }
  return n;
}

const yamlOf = (o) => JSON.stringify(o); // JSON is YAML; keeps the cases readable
const baseConfig = () => ({
  mode: 'report',
  owner: 'o',
  evidenceWindowDays: 45,
  packages: [{ name: 'mc-service', type: 'container', keepNewest: 2, keepDays: 30 }],
});

// ── config ────────────────────────────────────────────────────────────────────────────────────

test('config: the committed file loads, is report-only, and keeps every release APK', () => {
  const cfg = loadConfig(readFileSync(resolve(REPO_ROOT, CONFIG_PATH), 'utf8'));
  assert.equal(cfg.mode, 'report', 'the first production run must be report-only (FR-023)');
  const android = cfg.packages.find((p) => p.name === 'mcm-app-android');
  assert.equal(android?.keepAll, true, 'release APKs are not rebuildable');
  const apps = ['mc-service', 'mcm-bff', 'agent-gateway', 'movie-mcp', 'web-api-mcp', 'spreadsheet-mcp'];
  for (const name of apps) {
    const p = cfg.packages.find((x) => x.name === name);
    assert.ok(p, `${name} is not configured`);
    assert.ok(p.keepNewest >= 40 && p.keepDays >= 30, `${name} keeps less than R13's newest 40 / 30 days`);
  }
});

test('config: refuses an unknown key, at the top level and in a package', () => {
  assert.throws(() => loadConfig(yamlOf({ ...baseConfig(), modee: 'apply' })), (e) => e instanceof ConfigError && /modee/.test(e.message));
  const c = baseConfig();
  c.packages[0].keepNewst = 3;
  assert.throws(() => loadConfig(yamlOf(c)), /keepNewst/);
});

test('config: refuses a bad mode', () => {
  assert.throws(() => loadConfig(yamlOf({ ...baseConfig(), mode: 'delete' })), /mode/);
});

test('config: refuses a package that keeps nothing by rule', () => {
  const c = baseConfig();
  c.packages[0] = { name: 'x', type: 'container' };
  assert.throws(() => loadConfig(yamlOf(c)), /keepNewest|keepDays|keepAll/);
});

test('config: refuses a ci-failures window shorter than the evidence window', () => {
  const c = baseConfig();
  c.packages.push({ name: 'ci-failures', type: 'generic', keepDays: 30, keepNewest: 5000 });
  assert.throws(() => loadConfig(yamlOf(c)), /evidenceWindowDays|45/);
});

test('config: refuses a ci-failures keepNewest below the durations sample × bundle jobs', () => {
  const jobs = countBundleJobs();
  assert.ok(jobs > 10, `only ${jobs} bundle-publishing jobs found — the count is broken`);
  assert.equal(bundlePublishingJobs(), jobs, 'the script and the test count different jobs');
  const floor = DEFAULT_DURATION_RUNS * jobs;
  const c = baseConfig();
  c.packages.push({ name: 'ci-failures', type: 'generic', keepDays: 45, keepNewest: floor - 1 });
  assert.throws(() => loadConfig(yamlOf(c)), new RegExp(String(floor)));
  c.packages[1].keepNewest = floor;
  assert.doesNotThrow(() => loadConfig(yamlOf(c)));
});

// ── protected set from git ────────────────────────────────────────────────────────────────────

const digestOf = (n) => `sha256:${String(n).padStart(64, '0')}`;
function promotionRepo(commits) {
  const dir = mkdtempSync(join(tmpdir(), 'retention-git-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  for (let i = 1; i <= commits; i++) {
    for (const stack of ['mc-service', 'bff']) {
      mkdirSync(join(dir, 'infrastructure-as-code/docker', stack), { recursive: true });
      writeFileSync(
        join(dir, 'infrastructure-as-code/docker', stack, '.env.deploy'),
        `# GENERATED\nMC_SERVICE_DIGEST=${digestOf(i)}\nMCM_BFF_DIGEST=${digestOf(100 + i)}\n`,
      );
    }
    git('add', '-A');
    git('commit', '-q', '-m', `promote ${i}`);
    // An unrelated commit between promotions must not use up one of the five.
    writeFileSync(join(dir, 'README.md'), `r${i}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `docs ${i}`);
  }
  return dir;
}

test('protected set: HEAD plus the previous 5 promotions, and not the 7th-oldest', () => {
  const dir = promotionRepo(7);
  const p = protectedDigests({ cwd: dir });
  for (let i = 2; i <= 7; i++) {
    assert.ok(p.has(digestOf(i)), `promotion ${i} (a rollback target) is not protected`);
    assert.equal(p.get(digestOf(i)).package, 'mc-service');
    assert.ok(p.has(digestOf(100 + i)), `mcm-bff promotion ${i} is not protected`);
    assert.equal(p.get(digestOf(100 + i)).package, 'mcm-bff');
  }
  assert.ok(!p.has(digestOf(1)), 'the 7th-oldest promotion is protected — the window is not 6 commits');
});

test('protected set: the repository itself yields the six deployed digests', () => {
  const p = protectedDigests({ cwd: REPO_ROOT });
  const packages = new Set([...p.values()].map((x) => x.package));
  for (const name of ['mc-service', 'mcm-bff', 'agent-gateway', 'movie-mcp', 'web-api-mcp', 'spreadsheet-mcp']) {
    assert.ok(packages.has(name), `no protected digest for ${name}`);
  }
});

test('protected set: a shallow clone is refused, not read as "nothing to protect"', () => {
  const src = promotionRepo(3);
  const dir = mkdtempSync(join(tmpdir(), 'retention-shallow-'));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${src}`, dir]);
  assert.throws(() => protectedDigests({ cwd: dir }), /shallow/);
});

// ── decisions ─────────────────────────────────────────────────────────────────────────────────

/** The fixture slice as the collector would hand it to decide(). */
function sliceCollected() {
  const versions = SLICE.versions.map((v) => {
    const manifest = SLICE.files[v.version]?.find((f) => f.name === 'manifest.json');
    const index = SLICE.manifests[v.version]?.body;
    return {
      ...v,
      indexDigest: manifest ? `sha256:${manifest.sha256}` : null,
      children: (index?.manifests ?? []).map((m) => m.digest),
      size: (SLICE.files[v.version] ?? []).reduce((n, f) => n + f.Size, 0),
    };
  });
  return { 'mc-service': { type: 'container', versions } };
}
const tagVersions = () => SLICE.versions.filter((v) => /^[0-9a-f]{40}$/.test(v.version))
  .sort((a, b) => b.created_at.localeCompare(a.created_at));
const indexDigestOf = (tag) => `sha256:${SLICE.files[tag].find((f) => f.name === 'manifest.json').sha256}`;
const rowOf = (rows, version) => rows.find((r) => r.version === version);

test('decisions: newest N kept, the rest deleted, and each row carries its first keep reason', () => {
  const cfg = loadConfig(yamlOf(baseConfig()));
  const rows = decide({ config: cfg, packages: sliceCollected(), protectedSet: new Map(), now: NOW });
  const tags = tagVersions();
  assert.equal(rowOf(rows, tags[0].version).decision, 'keep:newest');
  assert.equal(rowOf(rows, tags[1].version).decision, 'keep:newest');
  // tags[2] and tags[3] are inside 30 days: kept by the time window, not by count.
  assert.equal(rowOf(rows, tags[2].version).decision, 'keep:recent');
  // The two from June are outside both windows.
  assert.equal(rowOf(rows, tags[4].version).decision, 'delete');
  assert.equal(rowOf(rows, tags[5].version).decision, 'delete');
});

test('decisions: a child is kept while ANY kept index references it — even when it is older', () => {
  const cfg = loadConfig(yamlOf(baseConfig()));
  const rows = decide({ config: cfg, packages: sliceCollected(), protectedSet: new Map(), now: NOW });
  const keptChildren = new Set(
    tagVersions().slice(0, 4).flatMap((t) => SLICE.manifests[t.version].body.manifests.map((m) => m.digest)),
  );
  for (const d of keptChildren) assert.equal(rowOf(rows, d)?.decision, 'keep:referenced', `${d} is not kept`);
  // The measured shared child: created by an earlier push and reused by the newest index.
  const newestChildren = SLICE.manifests[tagVersions()[0].version].body.manifests.map((m) => m.digest);
  const shared = SLICE.versions.find((v) => newestChildren.includes(v.version) && v.created_at < tagVersions()[0].created_at);
  assert.ok(shared, 'the fixture lost its shared child — re-record it');
  assert.equal(rowOf(rows, shared.version).decision, 'keep:referenced');
});

test('decisions: deployed and rollback digests older than every window are keep:protected', () => {
  const cfg = loadConfig(yamlOf(baseConfig()));
  const old = tagVersions()[5];
  const protectedSet = new Map([[indexDigestOf(old.version), { package: 'mc-service', source: 'HEAD~3' }]]);
  const rows = decide({ config: cfg, packages: sliceCollected(), protectedSet, now: NOW });
  assert.equal(rowOf(rows, old.version).decision, 'keep:protected');
  assert.equal(rowOf(rows, old.version).digest, indexDigestOf(old.version), 'the row does not carry the digest a reviewer greps for');
  for (const child of SLICE.manifests[old.version].body.manifests.map((m) => m.digest)) {
    assert.equal(rowOf(rows, child).decision, 'keep:referenced', 'a protected image lost a child');
  }
  // Under EVERY rule, no protected digest is in the delete list.
  for (const keepNewest of [1, 2, 6]) {
    for (const keepDays of [1, 30, 365]) {
      const c = loadConfig(yamlOf({ ...baseConfig(), packages: [{ name: 'mc-service', type: 'container', keepNewest, keepDays }] }));
      const r = decide({ config: c, packages: sliceCollected(), protectedSet, now: NOW });
      assert.notEqual(rowOf(r, old.version).decision, 'delete', `deleted under ${keepNewest}/${keepDays}`);
    }
  }
});

test('decisions: unreferenced children outside the window are deleted; inside it they are kept', () => {
  const cfg = loadConfig(yamlOf(baseConfig()));
  const rows = decide({ config: cfg, packages: sliceCollected(), protectedSet: new Map(), now: NOW });
  const referencedByAny = new Set(Object.values(SLICE.manifests).flatMap((m) => m.body.manifests.map((c) => c.digest)));
  const orphans = SLICE.versions.filter((v) => v.version.startsWith('sha256:') && !referencedByAny.has(v.version));
  assert.equal(orphans.length, 2);
  for (const o of orphans) assert.equal(rowOf(rows, o.version).decision, 'delete');
  const late = decide({ config: cfg, packages: sliceCollected(), protectedSet: new Map(), now: Date.parse('2026-07-02T00:00:00Z') });
  assert.equal(rowOf(late, orphans[1].version).decision, 'keep:recent', 'a fresh orphan may be a push in progress');
});

test('decisions: keepAll keeps everything, and an unconfigured package is reported, never deleted', () => {
  const cfg = loadConfig(yamlOf({ ...baseConfig(), packages: [{ name: 'mcm-app-android', type: 'generic', keepAll: true }] }));
  const packages = {
    'mcm-app-android': { type: 'generic', versions: [{ id: 1, version: '1.0.0-aaaaaaa', created_at: '2026-01-01T00:00:00Z', size: 9 }] },
    'mc-service': sliceCollected()['mc-service'],
  };
  const rows = decide({ config: cfg, packages, protectedSet: new Map(), now: NOW });
  assert.equal(rows.find((r) => r.package === 'mcm-app-android').decision, 'keep:all');
  const unconfigured = rows.filter((x) => x.package === 'mc-service');
  assert.equal(unconfigured.length, SLICE.versions.length, 'an unconfigured package must still be REPORTED, row by row');
  for (const r of unconfigured) assert.equal(r.decision, 'keep:unconfigured');
});

test('decisions: when a kept index cannot be read, no child of that package is deleted', () => {
  const cfg = loadConfig(yamlOf(baseConfig()));
  const packages = sliceCollected();
  const newest = packages['mc-service'].versions.find((v) => v.version === tagVersions()[0].version);
  newest.children = null; // the registry answered 404/500 for its index
  const rows = decide({ config: cfg, packages, protectedSet: new Map(), now: NOW });
  const children = rows.filter((r) => r.version.startsWith('sha256:'));
  assert.ok(children.length > 0);
  assert.ok(children.every((r) => r.decision !== 'delete'), 'a child was deleted while an index it may belong to was unread');
  assert.ok(children.some((r) => r.decision === 'keep:unverified'));
});

test('decisions: ci-failures inside its window is kept', () => {
  const floor = DEFAULT_DURATION_RUNS * countBundleJobs();
  const cfg = loadConfig(yamlOf({ ...baseConfig(), packages: [{ name: 'ci-failures', type: 'generic', keepDays: 45, keepNewest: floor }] }));
  const versions = Array.from({ length: floor + 3 }, (_, i) => ({
    id: i, version: `${9000 - i}--app-e2e`, created_at: new Date(NOW - i * 3600_000).toISOString(), size: 1,
  }));
  versions.push({ id: 99999, version: '1--app-e2e', created_at: new Date(NOW - 50 * 86400_000).toISOString(), size: 1 });
  const rows = decide({ config: cfg, packages: { 'ci-failures': { type: 'generic', versions } }, protectedSet: new Map(), now: NOW });
  assert.ok(rows.filter((r) => r.version !== '1--app-e2e').every((r) => r.decision.startsWith('keep:')));
  assert.equal(rowOf(rows, '1--app-e2e').decision, 'delete');
});

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────

/** A fake forge serving the slice, recording every call. */
function fakeForge({ slice = SLICE, extraVersions = [] } = {}) {
  const calls = [];
  const versions = [...slice.versions, ...extraVersions];
  const fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method ?? 'GET';
    calls.push({ method, path: u.pathname + u.search });
    const json = (o, headers = {}) => ({
      ok: true, status: 200, headers: new Map(Object.entries({ 'x-total-count': String(versions.length), ...headers })),
      json: async () => o, text: async () => JSON.stringify(o),
    });
    if (method === 'DELETE') return { ok: true, status: 204, headers: new Map(), text: async () => '' };
    if (u.pathname === '/api/v1/packages/o') {
      const page = Number(u.searchParams.get('page'));
      const limit = Number(u.searchParams.get('limit'));
      return json(versions.slice((page - 1) * limit, page * limit));
    }
    const files = u.pathname.match(/^\/api\/v1\/packages\/o\/(\w+)\/([^/]+)\/(.+)\/files$/);
    if (files) return json(slice.files[decodeURIComponent(files[3])] ?? []);
    const man = u.pathname.match(/^\/v2\/o\/([^/]+)\/manifests\/(.+)$/);
    if (man) {
      const m = slice.manifests[decodeURIComponent(man[2])];
      if (!m) return { ok: false, status: 404, headers: new Map(), json: async () => ({}), text: async () => '' };
      return json(m.body, { 'content-type': m.contentType });
    }
    throw new Error(`unexpected ${method} ${u.pathname}`);
  };
  return { fetch, calls, deletes: () => calls.filter((c) => c.method === 'DELETE') };
}

function writeConfig(o) {
  const dir = mkdtempSync(join(tmpdir(), 'retention-cfg-'));
  const p = join(dir, 'retention.yaml');
  writeFileSync(p, yamlOf(o));
  return p;
}

async function runCli(args, { config = baseConfig(), protectedSet = new Map(), forge = fakeForge(), env = {} } = {}) {
  const out = [];
  const err = [];
  const code = await main(args, {
    env: { MCM_FORGE_URL: 'http://forge.invalid', REGISTRY_CLEANUP_TOKEN: 't', ...env },
    fetch: forge.fetch,
    configPath: writeConfig(config),
    protectedDigests: () => protectedSet,
    now: NOW,
    log: (l) => out.push(String(l)),
    logError: (l) => err.push(String(l)),
  });
  return { code, out: out.join('\n'), err: err.join('\n'), forge };
}

test('CLI: no arguments reports, and makes ZERO delete calls', async () => {
  const r = await runCli([]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.forge.deletes().length, 0);
  assert.match(r.out, /mc-service\s+d7469efc\w*\s+2026-06-28\s+delete/);
  assert.match(r.out, /would free/);
});

test('CLI: --apply with mode: report exits 2 naming the mismatch, with zero deletes', async () => {
  const r = await runCli(['--apply']);
  assert.equal(r.code, 2);
  assert.match(r.err, /mode: report/);
  assert.equal(r.forge.deletes().length, 0);
});

test('CLI: --apply with mode: apply deletes only the delete rows', async () => {
  const r = await runCli(['--apply', '--json'], { config: { ...baseConfig(), mode: 'apply' } });
  assert.equal(r.code, 0, r.err);
  const report = JSON.parse(r.out);
  const deleted = r.forge.deletes().map((c) => decodeURIComponent(c.path.split('/').pop()));
  const expected = report.rows.filter((x) => x.decision === 'delete').map((x) => x.version);
  assert.ok(expected.length >= 4);
  assert.deepEqual([...deleted].sort(), [...expected].sort());
  // Indexes before children, so no kept index ever points at a deleted child mid-run.
  const firstChild = deleted.findIndex((v) => v.startsWith('sha256:'));
  assert.ok(deleted.slice(firstChild).every((v) => v.startsWith('sha256:')));
});

test('CLI: an unresolvable protected digest exits 5, names it, and deletes nothing', async () => {
  const protectedSet = new Map([[digestOf(42), { package: 'mc-service', source: 'HEAD' }]]);
  const r = await runCli(['--apply'], { config: { ...baseConfig(), mode: 'apply' }, protectedSet });
  assert.equal(r.code, 5);
  assert.match(r.err, new RegExp(digestOf(42)));
  assert.equal(r.forge.deletes().length, 0);
});

test('CLI: --dry-run and --package without a value are rejected with exit 2, before any call', async () => {
  for (const args of [['--dry-run'], ['--package'], ['--package', '--json'], ['--aply']]) {
    const r = await runCli(args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
    assert.equal(r.forge.calls.length, 0, `${args.join(' ')} reached the forge`);
  }
});

test('CLI: --help prints usage and exits 0 without a single call', async () => {
  const r = await runCli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /registry-retention\.mjs/);
  assert.equal(r.forge.calls.length, 0);
});

test('CLI: --json is valid JSON with per-package totals; --package narrows it', async () => {
  const r = await runCli(['--json', '--package', 'mc-service']);
  assert.equal(r.code, 0, r.err);
  const report = JSON.parse(r.out);
  const t = report.packages['mc-service'];
  assert.equal(t.total, SLICE.versions.length);
  assert.equal(t.keep + t.delete, t.total);
  assert.ok(t.bytesFreed > 0);
  assert.equal(report.mode, 'report');
});

test('CLI: no MCM_FORGE_URL or no token is a usage error, never a default host', async () => {
  for (const env of [{ MCM_FORGE_URL: '' }, { REGISTRY_CLEANUP_TOKEN: '', MCM_FORGE_TOKEN: '' }]) {
    const r = await runCli([], { env });
    assert.equal(r.code, 2, JSON.stringify(env));
    assert.equal(r.forge.calls.length, 0);
  }
});

// ── workflow ──────────────────────────────────────────────────────────────────────────────────

test('workflow: the schedule can never pass --apply, and protection reads full history', () => {
  const text = readFileSync(join(WORKFLOWS, 'registry-retention.yml'), 'utf8');
  const wf = parseYaml(text);
  assert.ok(wf.on.schedule, 'no weekly schedule');
  assert.equal(wf.on.workflow_dispatch?.inputs?.apply?.type, 'boolean');
  assert.equal(wf.on.workflow_dispatch.inputs.apply.default, false);
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps);
  const checkout = steps.find((s) => /actions\/checkout/.test(s.uses ?? ''));
  assert.equal(checkout?.with?.['fetch-depth'], 0, 'protection reads git history; a shallow clone protects nothing');
  const run = steps.find((s) => /registry-retention\.mjs/.test(s.run ?? ''));
  assert.ok(run, 'the workflow does not run the script');
  // --apply appears ONLY behind a dispatch with apply == true.
  const applies = [...run.run.matchAll(/--apply/g)];
  assert.equal(applies.length, 1, 'more than one --apply in the run step');
  assert.match(run.run, /github\.event_name == 'workflow_dispatch' && inputs\.apply == true\) && '--apply'/);
  assert.match(JSON.stringify(run.env ?? {}), /secrets\.REGISTRY_CLEANUP_TOKEN/);
});
