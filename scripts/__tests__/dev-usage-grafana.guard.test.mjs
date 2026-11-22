// Guard (feature 105 US3, T055): the "Claude Code usage" Grafana dashboard. It reads ONLY the usage
// views (usage_reader has no table rights, and views are the stable contract), it is mounted as single
// files beside otel-lgtm's own provisioning (a directory mount would hide the image's datasources), the
// datasource never becomes the default, and its password is a Komodo Variable, never a literal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OBS = resolve(ROOT, 'infrastructure-as-code', 'docker', 'observability');
const dash = JSON.parse(readFileSync(resolve(OBS, 'grafana', 'dashboards', 'claude-code-usage.json'), 'utf8'));
const sqls = dash.panels.flatMap((p) => p.targets.map((t) => t.rawSql));

test('every panel query reads only usage.v_* views', () => {
  assert.ok(sqls.length >= 6);
  for (const sql of sqls) {
    const refs = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][\w.]*)/gi)].map((m) => m[1]).filter((r) => r !== 'unnest');
    assert.ok(refs.length > 0, sql);
    for (const r of refs) assert.match(r, /^usage\.v_[a-z_]+$/, `${r} in: ${sql}`);
  }
});

test('the panels cover activity, area, spec, feature, the features table, no-feature and unclassified shares', () => {
  const titles = dash.panels.map((p) => p.title.toLowerCase()).join(' | ');
  for (const w of ['by activity', 'by area', 'by spec', 'by feature', 'features and their outcomes', 'no feature', 'unclassified']) assert.ok(titles.includes(w), w);
});

test('otel-lgtm mounts the three files individually, read-only, and gets the reader password from a Variable', () => {
  const c = parse(readFileSync(resolve(OBS, 'compose.prod.yaml'), 'utf8')).services['otel-lgtm'];
  const mounts = c.volumes.filter((v) => typeof v === 'string' && v.startsWith('./grafana/'));
  assert.deepEqual(mounts.map((m) => m.split(':')[1]).sort(), [
    '/otel-lgtm/dev-usage-dashboards/claude-code-usage.json',
    '/otel-lgtm/grafana/conf/provisioning/dashboards/dev-usage.yaml',
    '/otel-lgtm/grafana/conf/provisioning/datasources/zz-dev-usage.yaml',
  ]);
  assert.ok(mounts.every((m) => m.endsWith(':ro')));
  assert.match(c.environment.DEV_USAGE_READER_PASSWORD, /^\$\{DEV_USAGE_READER_PASSWORD:\?/);
  const toml = readFileSync(resolve(ROOT, 'infrastructure-as-code', 'komodo', 'stacks.toml'), 'utf8');
  const obs = toml.slice(toml.indexOf('name = "prod-observability"'));
  assert.match(obs.slice(0, obs.indexOf('[[stack]]', 10) === -1 ? undefined : obs.indexOf('[[stack]]', 10)), /^DEV_USAGE_READER_PASSWORD=\[\[DEV_USAGE_READER_PASSWORD\]\]$/m);
});

test('the datasource: usage_reader, never the default, password interpolated', () => {
  const ds = parse(readFileSync(resolve(OBS, 'grafana', 'datasources', 'zz-dev-usage.yaml'), 'utf8')).datasources[0];
  assert.equal(ds.user, 'usage_reader');
  assert.equal(ds.isDefault, false);
  assert.equal(ds.secureJsonData.password, '$DEV_USAGE_READER_PASSWORD');
  assert.equal(ds.uid, 'dev-usage-store');
  for (const p of dash.panels) assert.equal(p.datasource.uid, 'dev-usage-store');
});
