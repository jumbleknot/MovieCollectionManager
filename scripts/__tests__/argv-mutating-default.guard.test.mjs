// Item #500 — the mutating default behind an unrecognised argument.
//
// THE DEFECT CLASS, stated once. An argument the tool does not recognise AND does not REJECT runs in
// two directions. Under-action: the flag is ignored and the tool quietly does less than you asked
// (`--grep-invert` on Playwright 1.60; `node --test <file> --test-name-pattern x`). Over-action: the
// flag is ignored and the tool performs its DEFAULT action — and here the default was the
// destructive one:
//
//   renovate-health.mjs            a mis-typed --dry-run POSTED A PUBLIC COMMENT to item #311
//   prune-bff-runtime-modules.mjs  a mis-typed --dry-run DELETED FILES FOR REAL
//
// Neither warned. Neither exited non-zero. The exit code of the typo'd run was indistinguishable
// from the exit code of the intended one. `agent-stack.mjs` is the instance that actually fired
// (measured 2026-09-19 — `--help` began building movie-mcp:latest during a teardown session) and was
// fixed in PR #497; this pins the same contract on the two the audit found still live.
//
// Pure-function tests — no network, no filesystem mutation, no Docker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { usageNamesEveryFlag } from '../lib/argv-contract.mjs';
import * as renovateHealth from '../renovate-health.mjs';
import * as prune from '../prune-bff-runtime-modules.mjs';
import * as lockfileRefresh from '../check-lockfile-refresh.mjs';
import * as ciDigest from '../ci-failure-digest.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The near-miss spellings from the item. Every one of these used to mean "do the destructive thing".
const TYPOS = ['--dryrun', '--dry_run', '-dry-run', '--dry', '--dryRun', '--no-dry-run', '-n'];

// ── renovate-health.mjs — the blast radius is PUBLIC and not locally reversible ──────────────────

test('(#500) renovate-health REJECTS a mis-typed --dry-run instead of posting', () => {
  for (const flag of TYPOS) {
    assert.throws(
      () => renovateHealth.resolveCommand([flag]),
      /unrecognised|unrecognized|unknown/i,
      `${flag} must be REJECTED — falling through to the default is how a typo posts to item #311`,
    );
  }
});

test('(#500) renovate-health --help reports usage and posts NOTHING', () => {
  for (const flag of ['--help', '-h']) {
    assert.equal(renovateHealth.resolveCommand([flag]).command, 'help');
  }
});

test('(#500) renovate-health: the CONTROL — every currently-valid invocation is unchanged', () => {
  // The control that stops the assertions above being satisfied by a parser that rejects
  // EVERYTHING. The bare invocation matters most: .forgejo/workflows/renovate-health.yml invokes it
  // with no arguments, and breaking that would silence the weekly digest — whose whole design is
  // that absence reads as a dead job, not as health.
  assert.equal(renovateHealth.resolveCommand([]).command, 'post', 'a bare invocation must still POST');
  assert.equal(renovateHealth.resolveCommand(['--dry-run']).command, 'dry-run');
});

test('(#500) renovate-health: the weekly workflow still invokes the form that posts', () => {
  // A wiring guard. The test above pins the parser; this pins the CALLER, so a future edit that
  // makes the workflow pass a flag the parser now rejects fails here rather than on a Friday.
  const wf = readFileSync(resolve(REPO_ROOT, '.forgejo/workflows/renovate-health.yml'), 'utf8');
  const invocation = wf.split(/\r?\n/).find((l) => l.includes('renovate-health.mjs'));
  assert.ok(invocation, 'renovate-health.yml no longer invokes the script at all');
  const args = invocation.slice(invocation.indexOf('renovate-health.mjs') + 'renovate-health.mjs'.length).trim();
  assert.doesNotThrow(
    () => renovateHealth.resolveCommand(args ? args.split(/\s+/) : []),
    `the weekly workflow passes arguments the parser rejects: "${args}"`,
  );
  assert.equal(
    renovateHealth.resolveCommand(args ? args.split(/\s+/) : []).command,
    'post',
    'the weekly workflow must resolve to POST — a digest that renders but never posts is silence',
  );
});

test('(#500) renovate-health USAGE names every accepted flag', () => {
  assert.deepEqual(usageNamesEveryFlag(renovateHealth.USAGE, renovateHealth.ACCEPTED_FLAGS), []);
});

// ── prune-bff-runtime-modules.mjs — this one DELETES ─────────────────────────────────────────────
//
// Here the fix is an INVERSION, not a guard: dry-run is the default and `--apply` is required to
// delete. That removes the class rather than policing it — after this, a typo can only ever fail
// safe, even if some future caller bypasses the rejection entirely.

test('(#500) prune: a BARE invocation no longer deletes — dry-run is the default', () => {
  const cmd = prune.resolveCommand([]);
  assert.equal(cmd.command, 'prune');
  assert.equal(cmd.apply, false, 'a bare invocation must NOT delete — the inversion is the point');
});

test('(#500) prune: every typo resolves to a NON-deleting run or an error, never a delete', () => {
  // The inversion means a typo has two acceptable fates. What it must never have is a third.
  for (const flag of [...TYPOS, '--aply', '--apply-all', '-a']) {
    let cmd = null;
    try {
      cmd = prune.resolveCommand([flag]);
    } catch {
      continue; // rejected outright — the preferred outcome
    }
    assert.equal(cmd.apply, false, `${flag} resolved to a REAL DELETE — the inversion leaked`);
  }
});

test('(#500) prune: --apply is the only way to delete, and it still takes the target', () => {
  const cmd = prune.resolveCommand(['--apply', '/app/runtime']);
  assert.equal(cmd.command, 'prune');
  assert.equal(cmd.apply, true);
  assert.equal(cmd.target, '/app/runtime');
});

test('(#500) prune: --apply --dry-run is CONTRADICTORY and refused, not silently resolved', () => {
  // Refused rather than "last flag wins" or "safe wins": on a script that deletes, an operator who
  // typed both does not know what they asked for, and neither resolution is honest.
  assert.throws(() => prune.resolveCommand(['--apply', '--dry-run']), /both|contradict|conflict/i);
});

test('(#500) prune: the CONTROL — --check-bundle and the target defaults are unchanged', () => {
  const cb = prune.resolveCommand(['--check-bundle', 'dist/server']);
  assert.equal(cb.command, 'check-bundle');
  assert.equal(cb.target, 'dist/server');
  // The defaults the old `target ?? …` expressions supplied, pinned so the rewrite did not move them.
  assert.equal(prune.resolveCommand(['--check-bundle']).target, 'dist/server');
  assert.equal(prune.resolveCommand([]).target, '/app/runtime');
  // A second positional is ambiguous on a script that deletes a directory tree.
  assert.throws(() => prune.resolveCommand(['/app/runtime', '/app/other']), /positional|argument/i);
});

test('(#500) prune: the Dockerfile passes --apply, so the real build still prunes', () => {
  // The inversion is only safe if the ONE caller that must delete was updated with it. Without this
  // guard the change ships a 1.7 GB production image and nothing fails.
  const df = readFileSync(resolve(REPO_ROOT, 'frontend/mcm-app/Dockerfile'), 'utf8');
  const lines = df.split(/\r?\n/).filter((l) => l.includes('prune-bff-runtime-modules.mjs') && !l.startsWith('COPY'));
  assert.ok(lines.length >= 2, 'expected the --check-bundle call and the prune call in the Dockerfile');
  const pruneCall = lines.find((l) => !l.includes('--check-bundle'));
  assert.ok(pruneCall, 'the Dockerfile no longer invokes the prune itself');
  assert.match(pruneCall, /--apply/, 'the Dockerfile prune must pass --apply or it silently stops pruning');
  // And what it passes must actually resolve to a delete.
  const args = pruneCall.slice(pruneCall.indexOf('prune-bff-runtime-modules.mjs') + 'prune-bff-runtime-modules.mjs'.length).trim();
  const cmd = prune.resolveCommand(args.split(/\s+/));
  assert.equal(cmd.apply, true, `the Dockerfile's arguments resolve to a dry run: "${args}"`);
  assert.equal(cmd.target, '/app/runtime');
});

test('(#500) prune USAGE names every accepted flag', () => {
  assert.deepEqual(usageNamesEveryFlag(prune.USAGE, prune.ACCEPTED_FLAGS), []);
});

// ── The audit, re-run as a test rather than by hand ──────────────────────────────────────────────

test('(#500) every argv-dispatching script that can mutate has a RECORDED verdict', () => {
  // The item's scope note, discharged mechanically rather than by hand: "the defect is the MUTATING
  // default, not the missing --help. Do not fix all fifteen."
  //
  // WHY A TABLE RATHER THAN A HEURISTIC. The first draft of this test was a regex for rmSync/POST,
  // and it fired on five scripts. Two were real (check-lockfile-refresh.mjs, ci-failure-digest.mjs —
  // the manual audit in item #500 missed both); three were temp-dir cleanup behind a parser that
  // already rejects. A heuristic that over-fires gets LOOSENED until it passes, which is how an
  // audit stops auditing. So every script that both dispatches on argv and can mutate carries an
  // explicit verdict here, and a script with no verdict fails this test.
  const VERDICTS = {
    // FIXED — the default action mutates, so argv is routed through a rejecting resolveCommand().
    'agent-stack.mjs': 'guarded',            // built + deployed the stack on --help (PR #497)
    'renovate-health.mjs': 'guarded',        // posted a public comment to item #311
    'check-lockfile-refresh.mjs': 'guarded', // posted a public comment — renovate-health's ancestor
    'prune-bff-runtime-modules.mjs': 'guarded', // deleted files; ALSO inverted to --apply

    // EXEMPT — already rejects an unknown argument through its own parser, predating this module.
    // Re-homing them onto the shared mechanism is churn with no defect behind it.
    'check-openwiki-governance.mjs': 'rejects-already', // parseArgs → { error: `unknown argument` }
    'check-openwiki-okf.mjs': 'rejects-already',        // same parser shape
    'wiki-maintain.mjs': 'rejects-already',             // parseArgs throws, prints USAGE

    // FIXED in item #504, and the deferral's premise turned out to be wrong. FR-009's exit-0 rule
    // governs the DIGEST path, not argument-driven paths — `--selftest` has always hard-exited 1 on
    // failure. So rejecting a bad argument non-zero is consistent with the existing contract rather
    // than a violation of it. See the ci-failure-digest tests below for the evidence.
    'ci-failure-digest.mjs': 'guarded',
  };

  const scriptsDir = resolve(REPO_ROOT, 'scripts');
  // A call that reaches outside the process: deleting a path, or writing to the forge.
  const MUTATES = /\brmSync\s*\(|\bunlinkSync\s*\(|\brmdirSync\s*\(|call\(\s*'(?:POST|PATCH|PUT|DELETE)'/;
  const found = [];
  for (const name of readdirSync(scriptsDir).filter((n) => n.endsWith('.mjs'))) {
    const text = readFileSync(resolve(scriptsDir, name), 'utf8');
    if (!/process\.argv\.slice\(2\)|process\.argv\.includes\(/.test(text)) continue;
    if (!MUTATES.test(text)) continue; // read-only gate — a fall-through merely runs the check
    found.push(name);
  }

  const unreviewed = found.filter((n) => !(n in VERDICTS));
  assert.deepEqual(
    unreviewed,
    [],
    'these scripts dispatch on argv AND can mutate, but carry no audited verdict. Decide for each: ' +
      'route it through scripts/lib/argv-contract.mjs, or record WHY it is exempt — do not delete ' +
      'this assertion',
  );

  // And the four marked `guarded` must actually be guarded — a verdict is a claim, and an unchecked
  // claim in a test file is worth less than no test at all.
  for (const [name, verdict] of Object.entries(VERDICTS)) {
    if (verdict !== 'guarded') continue;
    const text = readFileSync(resolve(scriptsDir, name), 'utf8');
    assert.match(text, /resolveCommand/, `${name} is marked guarded but has no resolveCommand()`);
    assert.match(
      text,
      /argv-contract\.mjs/,
      `${name} is marked guarded but does not use the SHARED mechanism — a second copy is how the ` +
        'error path drifts, which is the one path nobody exercises until it matters',
    );
  }
});

test('(#500) check-lockfile-refresh has the same contract as the copy made from it', () => {
  // renovate-health.mjs's header names this file as the pattern it inherited. It inherited the
  // defect too, so fixing only the copy would have left the original posting on a typo.
  for (const flag of TYPOS) {
    assert.throws(() => lockfileRefresh.resolveCommand([flag]), /unrecognised|unknown/i);
  }
  assert.equal(lockfileRefresh.resolveCommand([]).command, 'post', 'a bare invocation must still POST');
  assert.equal(lockfileRefresh.resolveCommand(['--dry-run']).command, 'dry-run');
  assert.equal(lockfileRefresh.resolveCommand(['--help']).command, 'help');
  assert.deepEqual(usageNamesEveryFlag(lockfileRefresh.USAGE, lockfileRefresh.ACCEPTED_FLAGS), []);
});

test('(#500) the Dockerfile copies the lib the prune script now imports', () => {
  // Offline-knowable, and otherwise only a ~35-minute image build finds it: the script gained an
  // import of ./lib/argv-contract.mjs, which resolves relative to /build-scripts inside the image.
  // Copying the script without the lib is a MODULE_NOT_FOUND at build time, in two stages.
  const df = readFileSync(resolve(REPO_ROOT, 'frontend/mcm-app/Dockerfile'), 'utf8');
  const scriptCopies = (df.match(/^COPY scripts\/prune-bff-runtime-modules\.mjs /gm) ?? []).length;
  const libCopies = (df.match(/^COPY scripts\/lib\/argv-contract\.mjs /gm) ?? []).length;
  assert.equal(
    libCopies,
    scriptCopies,
    'every stage that COPYs the prune script must also COPY scripts/lib/argv-contract.mjs',
  );
});

// ── ci-failure-digest.mjs — item #504 ────────────────────────────────────────────────────
//
// This was deferred out of #500 because FR-009 ("this step must NEVER change a job's outcome",
// always exit 0) looked to contradict a rejection that exits non-zero. It does not, and the
// deferral's premise was simply wrong: `--selftest` has ALWAYS ended in `process.exit(1)` on
// failure. FR-009's exit-0 discipline therefore governs the DIGEST path only — the path that runs
// when no argument is given — and has never applied to argument-driven paths.
//
// Two further facts, both asserted below rather than assumed, make an argv rejection unreachable in
// CI anyway: every workflow call site passes NO arguments, and every one carries
// `continue-on-error: true`.

test('(#504) a mis-typed --selftest is REJECTED, never run as a real digest', () => {
  // The defect: `--seltest` fell through to run(), which POSTs a digest comment and a commit status.
  for (const flag of ['--seltest', '--self-test', '-selftest', '--selfcheck', '--dry-run', '-s']) {
    assert.throws(
      () => ciDigest.resolveCommand([flag]),
      /unrecognised|unrecognized|unknown/i,
      `${flag} must be REJECTED — falling through posts a digest comment for real`,
    );
  }
});

test('(#504) --help reports usage and posts NOTHING', () => {
  for (const flag of ['--help', '-h']) {
    assert.equal(ciDigest.resolveCommand([flag]).command, 'help');
  }
});

test('(#504) CONTROL — the bare invocation and --selftest resolve exactly as before', () => {
  // The bare form is what all 22 workflow call sites run. Breaking it would silence the failure
  // digest across every workflow at once.
  assert.equal(ciDigest.resolveCommand([]).command, 'digest', 'a bare invocation must still produce the digest');
  assert.equal(ciDigest.resolveCommand(['--selftest']).command, 'selftest');
});

test('(#504) USAGE names every accepted flag', () => {
  assert.deepEqual(usageNamesEveryFlag(ciDigest.USAGE, ciDigest.ACCEPTED_FLAGS), []);
});

test('(#504) FR-009 is intact: the DIGEST path still exits 0 and never hard-exits', () => {
  // The guarantee the deferral was protecting. The digest path must still set `process.exitCode`
  // rather than calling process.exit() — a hard exit discards queued stdout, and the no-token
  // fallback prints the entire digest to stdout.
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/ci-failure-digest.mjs'), 'utf8');
  const tail = src.slice(src.indexOf('run()'));
  assert.match(tail, /process\.exitCode = 0/, 'the digest path must still force exit 0');
  assert.doesNotMatch(tail, /process\.exit\(0\)/, 'the digest path must not hard-exit — it truncates stdout');
});

test('(#504) the argv rejection is SOFT: it sets exitCode rather than hard-exiting', () => {
  // Same reasoning as FR-009 above, applied to the rejection itself. This file is where that trap is
  // documented, so a hard exit here would contradict its own lesson: the usage text goes to stderr,
  // and stderr to a pipe is asynchronous too.
  const src = readFileSync(resolve(REPO_ROOT, 'scripts/ci-failure-digest.mjs'), 'utf8');
  assert.match(src, /dieOnArgvError\([^)]*hard:\s*false/s, 'the rejection must use the soft (non-hard-exit) form');
});

test('(#504) EVERY workflow call site is bare — so an argv error is unreachable in CI', () => {
  // The first of the two facts the decision rests on. If a future edit starts passing a flag, this
  // fails here rather than in a workflow that suddenly exits 2.
  const files = readdirSync(resolve(REPO_ROOT, '.forgejo/workflows')).filter((f) => f.endsWith('.yml'));
  let sites = 0;
  for (const f of files) {
    const text = readFileSync(resolve(REPO_ROOT, '.forgejo/workflows', f), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = /run:\s*node scripts\/ci-failure-digest\.mjs(.*)$/.exec(line);
      if (!m) continue;
      sites += 1;
      assert.equal(m[1].trim(), '', `${f}: the digest is invoked with arguments: ${line.trim()}`);
    }
  }
  assert.ok(sites >= 20, `expected the digest to be wired into ~22 steps, found ${sites}`);
});

test('(#504) EVERY workflow call site carries continue-on-error — the second backstop', () => {
  // The other fact. FR-009 says the step must never change a job's outcome; this is what actually
  // enforces it at the workflow level, independent of the script's own exit code.
  const files = readdirSync(resolve(REPO_ROOT, '.forgejo/workflows')).filter((f) => f.endsWith('.yml'));
  const uncovered = [];
  for (const f of files) {
    const lines = readFileSync(resolve(REPO_ROOT, '.forgejo/workflows', f), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/run:\s*node scripts\/ci-failure-digest\.mjs/.test(lines[i])) continue;
      if (lines[i].trim().startsWith('#')) continue;
      const indent = lines[i].length - lines[i].trimStart().length;
      let found = false;
      for (let j = i; j >= 0; j--) {
        const cur = lines[j];
        const ci = cur.length - cur.trimStart().length;
        if (cur.trimStart().startsWith('- ') && ci < indent) break; // start of this step
        if (/^\s*continue-on-error:\s*true/.test(cur)) { found = true; break; }
      }
      if (!found) uncovered.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(uncovered, [], 'these digest steps could red their job if the digest ever exits non-zero');
});
