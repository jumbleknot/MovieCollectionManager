// Guards scripts/check-no-server-imports.mjs (feature 077, T003 — FR-011; US2-AC3).
//
// The constitution's Frontend Separation of Concerns says the BFF-Layer "must run server-side and
// never be included client-side". Nothing enforced it, and the violation is not loud: a client
// component imported `@/bff-server/backup-run-summary` for five pure formatting helpers and
// shipped `luxon` — 70 KB — to every user on every route. Measured, feature 077.
//
// The cases below are the ones a plausible-looking gate gets wrong:
//
//   - matching only the `@/` alias, so `../../bff-server/x` walks straight past it;
//   - flagging `src/bff-server/**`'s own internal imports, which are correct by definition;
//   - flagging API routes, which are the SANCTIONED server-side consumer;
//   - flagging `import type`, which is erased at compile time and ships nothing — a gate that
//     fires on it teaches people to suppress it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-no-server-imports.mjs');

/**
 * Lay out a throwaway `frontend/mcm-app/src` tree and run the gate over it.
 * `files` maps a path relative to `src/` to its contents.
 */
function runGate(files, extraArgs = []) {
  const root = mkdtempSync(join(tmpdir(), 'no-server-imports-'));
  const src = join(root, 'frontend', 'mcm-app', 'src');
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(src, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  const r = spawnSync('node', [GATE, '--src', src, ...extraArgs], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, root };
}

test('a clean tree passes', () => {
  const { code, out } = runGate({
    'components/backups/run-history.tsx': "import { formatNextRun } from '@/utils/backup-run-summary';\n",
    'bff-server/backup-run-summary.ts': "import { DateTime } from 'luxon';\n",
  });
  assert.equal(code, 0, out);
});

test('flags an aliased client import, naming the file and the specifier', () => {
  const { code, out } = runGate({
    'components/backups/run-history.tsx': "import { formatNextRun } from '@/bff-server/backup-run-summary';\n",
  });
  assert.equal(code, 1, out);
  assert.match(out, /components\/backups\/run-history\.tsx/, 'must name the importing file');
  assert.match(out, /@\/bff-server\/backup-run-summary/, 'must name the specifier');
});

test('flags a RELATIVE import that resolves into bff-server', () => {
  // A gate that only matches the `@/` alias is bypassed by the form a refactor produces.
  const { code, out } = runGate({
    'components/backups/run-history.tsx': "import { x } from '../../bff-server/backup-run-summary';\n",
  });
  assert.equal(code, 1, out);
  assert.match(out, /run-history\.tsx/, out);
});

test('flags a require() as well as an import', () => {
  const { code, out } = runGate({
    'components/thing.tsx': "const { x } = require('@/bff-server/backup-run-summary');\n",
  });
  assert.equal(code, 1, out);
});

test('flags a bare re-export', () => {
  const { code, out } = runGate({
    'components/thing.tsx': "export { formatNextRun } from '@/bff-server/backup-run-summary';\n",
  });
  assert.equal(code, 1, out);
});

test('does NOT flag bff-server importing its own siblings', () => {
  const { code, out } = runGate({
    'bff-server/backup-schedule.ts': "import { x } from '@/bff-server/backup-run-summary';\n",
    'bff-server/nested/deep.ts': "import { y } from '../backup-schedule';\n",
  });
  assert.equal(code, 0, out);
});

test('does NOT flag an API route — the sanctioned server-side consumer', () => {
  const { code, out } = runGate({
    'app/bff-api/backups/jobs/index+api.ts': "import { x } from '@/bff-server/backup-run-summary';\n",
  });
  assert.equal(code, 0, out);
});

test('does NOT flag a type-only import', () => {
  // Erased at compile time; it ships nothing. Firing here teaches people to suppress the gate.
  const { code, out } = runGate({
    'components/thing.tsx': "import type { RunSummary } from '@/bff-server/backup-run-summary';\n",
  });
  assert.equal(code, 0, out);
});

test('does NOT flag test files', () => {
  const { code, out } = runGate({
    'bff-server/unit-tests/backup-schedule.test.ts': "import { x } from '@/bff-server/backup-schedule';\n",
    'components/thing.test.tsx': "import { x } from '@/bff-server/backup-run-summary';\n",
  });
  assert.equal(code, 0, out);
});

test('reports EVERY violation, not just the first', () => {
  const { code, out } = runGate({
    'components/a.tsx': "import { x } from '@/bff-server/one';\n",
    'components/b.tsx': "import { y } from '@/bff-server/two';\n",
  });
  assert.equal(code, 1, out);
  assert.match(out, /a\.tsx/, out);
  assert.match(out, /b\.tsx/, out);
});

test('flags a MULTI-LINE import — the shape that defeated the first version', () => {
  // `run-history.tsx`'s import spans five lines. A line-based scanner never sees `import` and
  // `from '...'` together, so the first version of this gate reported the real tree CLEAN of the
  // exact violation it was written for. Certifying an absence is worse than not looking.
  const { code, out } = runGate({
    'components/backups/run-history.tsx': [
      'import {',
      '  describeCollectionCounts,',
      '  formatNextRun,',
      "} from '@/bff-server/backup-run-summary';",
      '',
    ].join('\n'),
  });
  assert.equal(code, 1, out);
  assert.match(out, /run-history\.tsx/, out);
  assert.match(out, /@\/bff-server\/backup-run-summary/, out);
});

test('a module declaring @client-safe WITH a reason is exempt', () => {
  // Some modules under src/bff-server/ are genuinely client code (api-client.ts is the browser's
  // transport TO the BFF). The exemption lives in the module, not in an allowlist here, so it is
  // visible to whoever reads that file next.
  const { code, out } = runGate({
    'bff-server/api-client.ts': '// @client-safe: runs in the browser, carries the caller cookies\nexport const c = 1;\n',
    'hooks/use-thing.ts': "import { c } from '@/bff-server/api-client';\n",
  });
  assert.equal(code, 0, out);
});

test('a BARE @client-safe marker with no reason is NOT honoured', () => {
  // Otherwise the marker is an allowlist entry wearing a different hat: free to add, never
  // justified, and invisible in review.
  const { code, out } = runGate({
    'bff-server/api-client.ts': '// @client-safe\nexport const c = 1;\n',
    'hooks/use-thing.ts': "import { c } from '@/bff-server/api-client';\n",
  });
  assert.equal(code, 1, out);
});

test('the marker exempts only the module that carries it', () => {
  const { code, out } = runGate({
    'bff-server/api-client.ts': '// @client-safe: browser transport to the BFF, by design\nexport const c = 1;\n',
    'bff-server/backup-run-summary.ts': 'export const f = 1;\n',
    'hooks/use-thing.ts': "import { c } from '@/bff-server/api-client';\n",
    'components/run-history.tsx': "import { f } from '@/bff-server/backup-run-summary';\n",
  });
  assert.equal(code, 1, out);
  assert.match(out, /run-history\.tsx/, 'the unmarked module must still be flagged');
  assert.doesNotMatch(out, /use-thing\.ts/, 'the marked module must not be flagged');
});

test('the failure output explains the marker, so the fix is discoverable', () => {
  const { out } = runGate({
    'components/thing.tsx': "import { x } from '@/bff-server/y';\n",
  });
  assert.match(out, /@client-safe/, 'must tell the reader the escape hatch exists');
  assert.match(out, /src\/utils/, 'must name the usual fix');
});

test('--selftest exits 0 on a healthy gate', () => {
  const r = spawnSync('node', [GATE, '--selftest'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test('an unknown flag exits 2 and does not scan', () => {
  // The argv-contract rule: an unrecognised argument REJECTS. It never leaves the default
  // action running under a name the caller did not type.
  const r = spawnSync('node', [GATE, '--dry_run'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(`${r.stdout}`, /files scanned/i, 'must not have scanned');
});

test('--help exits 0 without scanning', () => {
  const r = spawnSync('node', [GATE, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /--selftest/, 'usage must name every flag');
});

test('the REAL tree is clean', () => {
  // The gate exists because the real tree was dirty. This asserts feature 077 actually fixed it.
  const r = spawnSync('node', [GATE], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});
