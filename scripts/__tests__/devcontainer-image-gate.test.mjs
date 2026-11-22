// devcontainer-image must rebuild when the root `packageManager` moves (the image installs pnpm at
// that pin), and only then among package.json changes — see scripts/devcontainer-image-gate.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { decide, IMAGE_INPUTS, packageManagerAt, main } from '../devcontainer-image-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOW = join(ROOT, '.forgejo/workflows/devcontainer-image.yml');
const SHA = 'a'.repeat(40);

const push = (over) => ({ event: 'push', before: SHA, changedFiles: [], ...over });

test('the 2026-11-20 case: a packageManager bump in package.json builds', () => {
  const d = decide(push({ changedFiles: ['package.json', 'pnpm-lock.yaml'], pmBefore: 'pnpm@12.20.0', pmAfter: 'pnpm@12.21.0' }));
  assert.equal(d.build, true, d.reason);
});

test('a dependency bump that leaves packageManager alone does not build', () => {
  const d = decide(push({ changedFiles: ['package.json', 'pnpm-lock.yaml'], pmBefore: 'pnpm@12.21.0', pmAfter: 'pnpm@12.21.0' }));
  assert.equal(d.build, false, d.reason);
});

test('every image input builds on its own', () => {
  for (const f of IMAGE_INPUTS) assert.equal(decide(push({ changedFiles: [f] })).build, true, f);
});

test('non-push events always build (dispatch, the weekly cron)', () => {
  for (const event of ['workflow_dispatch', 'schedule', '']) assert.equal(decide({ event }).build, true, event);
});

test('fail-safe: anything unknown decides build', () => {
  assert.equal(decide(push({ before: '0'.repeat(40) })).build, true, 'zero sha (new branch)');
  assert.equal(decide(push({ before: '' })).build, true, 'no before');
  assert.equal(decide(push({ changedFiles: undefined })).build, true, 'diff failed');
  assert.equal(decide(push({ changedFiles: ['package.json'], pmBefore: undefined, pmAfter: 'pnpm@1.0.0' })).build, true, 'unreadable before');
});

test('packageManagerAt: value, absent, unparseable', () => {
  assert.equal(packageManagerAt('x', () => '{"packageManager":"pnpm@12.21.0"}'), 'pnpm@12.21.0');
  assert.equal(packageManagerAt('x', () => '{}'), '');
  assert.equal(packageManagerAt('x', () => 'not json'), undefined);
  assert.equal(packageManagerAt('x', () => { throw new Error('no such rev'); }), undefined);
});

test('workflow push paths are exactly IMAGE_INPUTS plus package.json', () => {
  const paths = parse(readFileSync(WORKFLOW, 'utf8')).on.push.paths;
  assert.deepEqual([...paths].sort(), [...IMAGE_INPUTS, 'package.json'].sort());
});

test('every step after the gate except the failure digest is conditioned on it', () => {
  const steps = parse(readFileSync(WORKFLOW, 'utf8')).jobs['build-publish'].steps;
  const gateAt = steps.findIndex((s) => s.id === 'gate');
  assert.ok(gateAt > 0, 'a step with id: gate exists after checkout');
  assert.match(steps[gateAt].run, /devcontainer-image-gate\.mjs/);
  assert.equal(steps[gateAt].env?.GATE_BEFORE, '${{ github.event.before }}');
  const checkout = steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout'));
  assert.equal(checkout.with?.['fetch-depth'], 0, 'the gate diffs against before, so it needs history');
  for (const s of steps.slice(gateAt + 1)) {
    if (/ci-failure-digest\.mjs/.test(s.run ?? '')) continue;
    assert.equal(s.if, "steps.gate.outputs.build == 'true'", `step "${s.name}" must be gated`);
  }
});

test('main writes build=… to GITHUB_OUTPUT and rejects an unknown argument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devimg-gate-'));
  const out = join(dir, 'out');
  try {
    const log = console.log;
    console.log = () => {};
    try {
      assert.equal(main([], { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_OUTPUT: out }), 0);
    } finally {
      console.log = log;
    }
    assert.equal(readFileSync(out, 'utf8'), 'build=true\n');
    const err = console.error;
    console.error = () => {};
    try {
      assert.equal(main(['--dry-run'], { GITHUB_EVENT_NAME: 'push' }), 2);
    } finally {
      console.error = err;
      process.exitCode = 0;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
