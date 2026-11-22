// Guard (feature 105, research R20): the usage-store integration tier runs in CI on every change that
// can break it. A never-attempted job and a clean one both look green, so this pins the change
// filter, the job, its runner and the flag that turns a missing stack into a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wf = parse(readFileSync(resolve(ROOT, '.forgejo/workflows/app-ci.yml'), 'utf8'));

const filters = () => {
  const step = wf.jobs.changes.steps.find((s) => s.id === 'filter');
  return parse(step.with.filters);
};

test('the changes job exposes a dev-usage output over the store\'s paths', () => {
  assert.equal(wf.jobs.changes.outputs['dev-usage'], '${{ steps.filter.outputs.dev-usage }}');
  assert.deepEqual(filters()['dev-usage'], [
    'infrastructure-as-code/docker/dev-usage/**',
    'scripts/cc-usage.mjs',
    'scripts/lib/cc-usage/**',
    'infrastructure-as-code/docker/keycloak/*-realm.json',
    // US3: the integration tier runs every Grafana panel query as usage_reader against the views.
    'infrastructure-as-code/docker/observability/grafana/**',
  ]);
});

test('app-ci has a dev-usage-integration job on kvm that fails rather than skips without a stack', () => {
  const job = wf.jobs['dev-usage-integration'];
  assert.ok(job, 'app-ci has no dev-usage-integration job');
  assert.equal(job['runs-on'], 'kvm');
  assert.ok(job.needs.includes('changes'));
  assert.match(job.if, /needs\.changes\.outputs\.dev-usage == 'true'/);
  assert.equal(job.env.MCM_REQUIRE_LIVE_STACK, '1');
  assert.equal(job.env.DOCKER_HOST, 'unix:///run/user/1001/docker.sock');
  assert.ok(job['timeout-minutes'] > 0, 'a timeout is set');
  const run = job.steps.map((s) => s.run ?? '').join('\n');
  assert.match(run, /scripts\/ci-log-step\.sh \S+ pnpm nx dev-usage-integration infrastructure-as-code/);
  assert.ok(job.steps.some((s) => /ci-failure-digest\.mjs/.test(s.run ?? '')), 'publishes a failure digest');
});

test('the app filter is unchanged by this feature (research R20)', () => {
  assert.ok(!filters().app.includes('scripts/cc-usage.mjs'));
  assert.ok(!filters().app.some((p) => p.includes('dev-usage')));
});
