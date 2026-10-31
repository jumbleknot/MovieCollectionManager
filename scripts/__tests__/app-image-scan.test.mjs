// Spec 084 US3 / item #822 — a fixable Critical in an app image fails the PR, not the deploy.
//
// Until this existed the six app images were scanned in ONE place: cd-deploy's scan-push step,
// which runs after the merge. A Critical that a base-image or dependency bump introduced therefore
// passed every PR check and surfaced as a failed DEPLOY on `main` (2026-10-21: run 5745, scan-push),
// where nothing blocks and the next merge walks past it.
//
// The PR now runs the deploy gate's exact pipeline on the images app-e2e already built:
//
//   app-e2e         builds the six images, then tags each `app-scan/<name>:run-<run id>`
//   app-image-scan  scans those six tags through scripts/cd/scan-app-image.sh   (required)
//   trigger-cd      needs app-image-scan, so a red scan on `main` blocks the dispatch too
//
// ONE pipeline, so one scanner pin, one set of flags and one allowlist. The drift guard below fails
// if either caller starts scanning on its own, or if the two image lists disagree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SHARED = 'scripts/cd/scan-app-image.sh';
const read = (p) => readFileSync(resolve(REPO_ROOT, p), 'utf8');
/** Executable lines only: the comments quote the old inline commands on purpose. */
const code = (text) => text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');

const SCAN_PUSH = code(read('scripts/cd/scan-push.sh'));
const APP_CI_TEXT = read('.forgejo/workflows/app-ci.yml');
const APP_CI = parseYaml(APP_CI_TEXT);

const scanJob = () => {
  const j = APP_CI?.jobs?.['app-image-scan'];
  assert.ok(j, 'app-ci has no app-image-scan job — every wiring assertion would pass vacuously');
  return j;
};
const runOf = (steps) => steps.map((s) => s.run ?? '').join('\n');

/** The six repositories scan-push.sh pushes, from its `map` (local-tag=repo pairs). */
function scanPushRepos() {
  const m = SCAN_PUSH.match(/map="([^"]+)"/);
  assert.ok(m, 'scan-push.sh no longer declares its image map as `map="…"` — re-check this guard');
  return m[1].split(/\s+/).filter((p) => p.includes('=')).map((p) => p.split('=')[1]).filter(Boolean);
}

// ── drift ─────────────────────────────────────────────────────────────────────────────────────

test('drift: scan-push.sh and the app-image-scan job both scan through scan-app-image.sh', () => {
  assert.match(SCAN_PUSH, /scripts\/cd\/scan-app-image\.sh/, 'scan-push.sh does not call the shared scan');
  assert.match(runOf(scanJob().steps), /scripts\/cd\/scan-app-image\.sh/, 'app-image-scan does not call the shared scan');
});

test('drift: neither caller runs the scanner or the verdict itself', () => {
  for (const [name, text] of [['scan-push.sh', SCAN_PUSH], ['app-image-scan', code(runOf(scanJob().steps))]]) {
    for (const re of [/\btrivy\s+image\b/, /infra-image-scan\.mjs/, /check-infra-image-findings\.mjs/]) {
      assert.doesNotMatch(text, re, `${name} runs ${re} directly — a second copy of the pipeline drifts`);
    }
  }
  // …and the shared script is where they now live, in order.
  const shared = code(read(SHARED));
  const scanAt = shared.indexOf('infra-image-scan.mjs --image');
  const verdictAt = shared.indexOf('check-infra-image-findings.mjs');
  assert.ok(scanAt >= 0 && verdictAt > scanAt, 'scan-app-image.sh must scan, then take the verdict');
});

test('drift: the job scans exactly the six images scan-push.sh pushes', () => {
  const repos = scanPushRepos();
  assert.equal(repos.length, 6, `scan-push.sh's map has ${repos.length} images, not 6`);
  const scanned = [...runOf(scanJob().steps).matchAll(/scan-app-image\.sh\s+"?app-scan\/([\w-]+):/g)].map((m) => m[1]);
  assert.deepEqual([...scanned].sort(), [...repos].sort(), 'the PR scans a different image set than the deploy pushes');
  const tagged = APP_CI.jobs['app-e2e'].steps.find((s) => /Tag images for app-image-scan/.test(s.name ?? ''));
  assert.ok(tagged, 'app-e2e has no "Tag images for app-image-scan" step');
  const list = tagged.run.match(/for name in ([\w\s-]+?); do/);
  assert.ok(list, 'the tag step no longer loops `for name in …; do`');
  assert.deepEqual(list[1].trim().split(/\s+/).sort(), [...repos].sort(), 'app-e2e tags a different image set');
});

// ── exit meanings ─────────────────────────────────────────────────────────────────────────────

/** Run the shared script with a fake `node` that answers per script name. */
function runShared(args, { scan = 0, findings = 0 } = {}) {
  const bin = mkdtempSync(join(tmpdir(), 'scan-app-image-'));
  const log = join(bin, 'calls.log');
  writeFileSync(join(bin, 'node'), [
    '#!/usr/bin/env bash',
    `echo "$*" >> ${JSON.stringify(log)}`,
    'case "$1" in',
    `  scripts/infra-image-scan.mjs) exit ${scan} ;;`,
    `  scripts/check-infra-image-findings.mjs) echo "  BLOCK CVE-2026-0001 libfoo"; exit ${findings} ;;`,
    '  *) echo "unexpected node $*" >&2; exit 99 ;;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'node'), 0o755);
  const r = spawnSync('bash', [SHARED, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

test('exit meanings: a clean scan exits 0, and scans the tag it was given', () => {
  const r = runShared(['app-scan/movie-mcp:run-42']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls, /infra-image-scan\.mjs --image app-scan\/movie-mcp:run-42/);
  assert.match(r.calls, /check-infra-image-findings\.mjs/);
});

test('exit meanings: a scanner failure exits 10, says SCANNER ERROR, and takes no verdict', () => {
  const r = runShared(['app-scan/movie-mcp:run-42'], { scan: 1 });
  assert.equal(r.code, 10, r.out);
  assert.match(r.out, /SCANNER ERROR/);
  assert.match(r.out, /movie-mcp/);
  assert.doesNotMatch(r.calls, /check-infra-image-findings/, 'a verdict was taken on a scan that did not run');
});

test('exit meanings: a blocking finding exits 11, says BLOCKING FINDING and names the image', () => {
  const r = runShared(['app-scan/movie-mcp:run-42'], { findings: 1 });
  assert.equal(r.code, 11, r.out);
  assert.match(r.out, /BLOCKING FINDING in movie-mcp/);
  assert.match(r.out, /CVE-2026-0001/, "the verdict's own table (which names the CVE) must reach the log");
});

test('exit meanings: no argument, two arguments, or an empty one exits 2 before scanning', () => {
  for (const args of [[], ['a:1', 'b:2'], ['']]) {
    const r = runShared(args);
    assert.equal(r.code, 2, `${JSON.stringify(args)}: ${r.out}`);
    assert.equal(r.calls, '', `${JSON.stringify(args)} scanned something`);
  }
});

test('exit meanings: scan-push.sh maps 10 and 11 to its two messages and fails closed on anything else', () => {
  assert.match(SCAN_PUSH, /\b10\)[\s\S]*?SCANNER ERROR[\s\S]*?exit 1/, 'exit 10 is not mapped to the scanner-error message');
  assert.match(SCAN_PUSH, /\b11\)[\s\S]*?BLOCKING FINDING[\s\S]*?exit 1/, 'exit 11 is not mapped to the finding message');
  assert.match(SCAN_PUSH, /\*\)[\s\S]*?exit 1/, 'an unexpected exit code must fail closed, never push');
  // The shared call precedes the push inside the per-image loop — a gate after `docker push` gates nothing.
  const body = SCAN_PUSH.slice(SCAN_PUSH.indexOf('for pair in $map; do'), SCAN_PUSH.indexOf('\ndone'));
  const callAt = body.indexOf('scan-app-image.sh');
  const pushAt = body.search(/^\s*docker push/m);
  assert.ok(callAt >= 0 && pushAt > callAt, 'the shared scan must run inside the loop, before docker push');
});

// ── wiring ────────────────────────────────────────────────────────────────────────────────────

test('wiring: app-image-scan runs on kvm after app-e2e, whatever app-e2e did', () => {
  const j = scanJob();
  assert.equal(j['runs-on'], 'kvm', 'the images live on the ci daemon the kvm runner talks to');
  const needs = [].concat(j.needs ?? []);
  for (const n of ['changes', 'app-e2e']) assert.ok(needs.includes(n), `app-image-scan does not need ${n}`);
  assert.match(String(j.if ?? ''), /always\(\)/, 'without always() a skipped app-e2e skips the scan, and a required context never posts');
});

test('wiring: it passes early, and says why, when no app path changed', () => {
  const steps = scanJob().steps;
  const decide = steps.find((s) => /needs\.changes\.outputs\.app|APP_CHANGED/.test(JSON.stringify(s)));
  assert.ok(decide, 'no step reads changes.outputs.app');
  assert.match(decide.run ?? '', /no app path changed/);
  // Every scanning step is conditional on the decision, so the early pass scans nothing.
  for (const s of steps.filter((x) => /scan-app-image\.sh/.test(x.run ?? ''))) {
    assert.match(String(s.if ?? ''), /RUN_SCAN == 'true'/, `${s.name} runs even when there is nothing to scan`);
  }
});

test('wiring: it runs on pushes to main too, so a red scan blocks trigger-cd before any dispatch', () => {
  const j = scanJob();
  assert.doesNotMatch(String(j.if ?? ''), /pull_request/, 'app-image-scan is restricted to pull requests');
  const t = APP_CI.jobs['trigger-cd'];
  assert.ok([].concat(t.needs).includes('app-image-scan'), 'trigger-cd does not need app-image-scan');
  assert.match(t.if, /needs\.app-image-scan\.result == 'success'/, 'trigger-cd must require a passed scan');
});

test('wiring: a missing scan tag fails the job, naming it — never a pass on images it could not find', () => {
  const verify = scanJob().steps.find((s) => /Verify the six scan tags/.test(s.name ?? ''));
  assert.ok(verify, 'no "Verify the six scan tags" step');
  assert.match(verify.run, /docker image inspect/);
  assert.match(verify.run, /app-scan\/\$name:run-\$\{\{ github\.run_id \}\}|app-scan\/\$\{?name\}?:\$\{?SCAN_TAG/);
  assert.match(verify.run, /missing/i);
  assert.match(verify.run, /exit 1/);
});

test('wiring: app-e2e tags the six images after the agent stack is built, with the run-scoped tag', () => {
  const steps = APP_CI.jobs['app-e2e'].steps;
  const at = (re) => steps.findIndex((s) => re.test(s.name ?? ''));
  const agents = at(/Bring up containerized agent gateway/);
  const builds = at(/Build mc-service \+ mcm-bff images/);
  const tag = at(/Tag images for app-image-scan/);
  assert.ok(tag > agents && tag > builds, 'the images are tagged before all six are built');
  assert.match(steps[tag].run, /app-e2e-tag-scan-images/);
  assert.match(steps[tag].run, /docker tag "\$name:latest" "app-scan\/\$name:run-\$\{\{ github\.run_id \}\}"/);
  // Tagging is unconditional within the job, so a later failing step cannot leave the scan nothing.
  assert.equal(steps[tag].if, undefined);
});

test('wiring: the tags are removed afterwards, even when the scan failed', () => {
  const rm = scanJob().steps.find((s) => /docker (image )?rm/.test(s.run ?? ''));
  assert.ok(rm, 'the run-scoped tags are never removed — they accumulate on the ci daemon');
  assert.match(String(rm.if ?? ''), /always\(\)/);
});

test("wiring: cd-deploy's scan-push step is unchanged in position — the deploy gate stays", () => {
  const cd = parseYaml(read('.forgejo/workflows/cd-deploy.yml'));
  const steps = cd.jobs['build-deploy'].steps;
  const at = (re) => steps.findIndex((s) => re.test(s.run ?? ''));
  const build = at(/build-images\.sh/);
  const scan = at(/scan-push\.sh/);
  assert.ok(build >= 0 && scan === build + 1, 'scan-push no longer runs straight after the image build');
});

test('wiring: ci-status treats app-image-scan as required, and the app filter covers the script', async () => {
  const { REQUIRED_CONTEXT_GLOBS } = await import('../ci-status.mjs');
  assert.ok(REQUIRED_CONTEXT_GLOBS.includes('app-ci / app-image-scan*'));
  assert.match(APP_CI_TEXT, /^\s+- 'scripts\/cd\/scan-app-image\.sh'/m, 'a change to the shared scan would skip the job that runs it');
});

test('wiring: every new ci-log-step name is accounted for in ci-step-ceilings.tsv', () => {
  const tsv = read('scripts/ci-step-ceilings.tsv');
  const names = [
    ...APP_CI_TEXT.matchAll(/ci-log-step\.sh\s+(app-image-scan[\w-]*|app-e2e-tag-scan-images)\b/g),
  ].map((m) => m[1]);
  assert.ok(names.length >= 8, `only ${names.length} app-image-scan step(s) found`);
  for (const n of new Set(names)) {
    assert.match(tsv, new RegExp(`^#?\\s*${n}\\t`, 'm'), `${n} is neither calibrated nor listed ON THE BACKSTOP`);
  }
});
