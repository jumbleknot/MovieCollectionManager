// Guard: a script's "am I the entry point?" check must work on every platform.
//
// WHAT WENT WRONG. Seven scripts guarded their CLI with
//     if (import.meta.url === `file://${process.argv[1]}`) { … }
// On Windows import.meta.url is `file:///E:/…/x.mjs` and argv[1] is `E:\…\x.mjs`, so the comparison
// is never true: the script exits 0 having run NOTHING — a gate that reports a pass it never checked,
// found when check-speckit-overrides.mjs printed no verdict on the host (PR #1029). On Linux it held
// only because an absolute POSIX path happens to equal its URL's path; a path with a space or `%`
// (percent-encoded in the URL) broke it there too.
//
// The fix is scripts/lib/is-main.mjs (pathToFileURL, the same encoding import.meta.url uses). This
// file fails if the old shape reappears anywhere under scripts/, and runs each fixed script as a real
// subprocess so "it printed something" is measured, not assumed. Every probe is read-only: --help, or
// e2e-failure-set's `summary` over a fixture. NEVER probe renovate-health
// bare — a bare run POSTS a forge comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../lib/is-main.mjs';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BROKEN = /import\.meta\.url\s*===\s*`file:\/\/\$\{process\.argv\[1\]\}`/;

function* mjsFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* mjsFiles(p);
    else if (e.name.endsWith('.mjs')) yield p;
  }
}

test('no script under scripts/ uses the Windows-blind `file://${process.argv[1]}` entry check', () => {
  const offenders = [...mjsFiles(SCRIPTS)].filter((f) => BROKEN.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map((f) => relative(SCRIPTS, f)), []);
});

test('isMain: true for the running file, false for another, false with no argv[1]', () => {
  const here = fileURLToPath(import.meta.url);
  assert.equal(isMain(import.meta.url, here), true);
  assert.equal(isMain(import.meta.url, join(SCRIPTS, 'not-this-file.mjs')), false);
  // '' not undefined: undefined selects the default (process.argv[1]), which under `node --test` IS
  // this file — node -e / a REPL is the real no-argv[1] case, and it arrives as ''-or-absent.
  assert.equal(isMain(import.meta.url, ''), false);
});

test('isMain: a real module run from a path with a space and a % sees itself as main', () => {
  // Node builds import.meta.url itself here, so this measures the encoding rather than restating it.
  const dir = mkdtempSync(join(tmpdir(), 'cli entry %guard-'));
  try {
    const mod = join(dir, 'probe.mjs');
    const lib = pathToFileURL(join(SCRIPTS, 'lib', 'is-main.mjs')).href;
    writeFileSync(mod, `import { isMain } from ${JSON.stringify(lib)};\nconsole.log('isMain=' + isMain(import.meta.url));\n`);
    const r = spawnSync(process.execPath, [mod], { encoding: 'utf8' });
    assert.equal(r.stdout.trim(), 'isMain=true', r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Each --help text shows its own invocation line, so that is what proves the entry point ran.
const helpNames = (script) => new RegExp(`node scripts/${script.replace('.', '\\.')}`);
const PROBES = [
  ...[
    'check-speckit-overrides.mjs',
    'renovate-verdict.mjs',
    'renovate-health.mjs',
    'reap-merged-branches.mjs',
    'check-no-server-imports.mjs',
    'check-web-bundle-budget.mjs',
    'check-version-pins.mjs',
  ].map((s) => [s, ['--help'], helpNames(s)]),
  ['e2e-failure-set.mjs', ['summary', '<fixture>'], /^failed=1 flaky=0 passed=2\b/m],
];

for (const [script, args, expect] of PROBES) {
  test(`${script} runs when invoked directly (${args[0]})`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-entry-guard-'));
    try {
      const log = join(dir, 'web-e2e.log');
      writeFileSync(log, '  1 failed\n    [chromium] › tests/e2e/web/a.spec.ts:1:1 › a › b\n  2 passed (1.0m)\n');
      const argv = args.map((a) => (a === '<fixture>' ? log : a));
      const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...argv], { encoding: 'utf8', timeout: 60_000 });
      const out = `${r.stdout}${r.stderr}`;
      assert.match(out, expect, `exit=${r.status}; the entry point did not run (output: ${JSON.stringify(out.slice(0, 200))})`);
      assert.equal(r.status, 0, out.slice(0, 500));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
