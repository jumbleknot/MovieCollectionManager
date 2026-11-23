// Item #1107 — a regex literal that OPENS with `<!--` silently blinds Semgrep.
//
// WHY THIS GUARD EXISTS. Semgrep's JavaScript parser honours the Annex B HTML-comment opener, so in
// `/<!--\s*x/` it reads `<!--` as the start of a comment, not as regex text. Measured with the pinned
// semgrep 1.185.0 on 2026-11-23: `scripts/__tests__/ci-failure-digest.test.mjs` was not parsed AT ALL
// (0 results), and `ci-failure-digest.mjs`, `ci-status.mjs` and `check-openwiki-governance.mjs` were
// only partly parsed. Nothing failed: the parse error lands in Semgrep's `errors[]`, which the gate does
// not treat as a finding. So every rule simply skipped that code. Found by the BELAY port.
//
// The fix is to write the same regex as `<[!]--`, which matches identical text. Measured on the same
// pin: `/^<!--` (an anchor between the slash and `<!--`) parses cleanly, so the trigger is `<!--`
// IMMEDIATELY after the opening slash — which is what this guard looks for.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SELF = 'scripts/__tests__/semgrep-html-comment-regex.guard.test.mjs';
// Assembled so this file does not contain the shape it bans.
const BANNED = '/' + '<!--';

export function offendingLines(text) {
  return text.split(/\r?\n/).flatMap((l, i) => (l.includes(BANNED) ? [i + 1] : []));
}

test('#1107: no tracked JS/TS file has a regex literal opening with <!--', () => {
  const files = execFileSync('git', ['ls-files', '*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.tsx'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter((f) => f && f !== SELF);
  const hits = [];
  for (const f of files) {
    for (const n of offendingLines(readFileSync(resolve(REPO_ROOT, f), 'utf8'))) hits.push(`${f}:${n}`);
  }
  assert.deepEqual(hits, [], `Semgrep cannot parse past these — write the regex as <[!]-- instead:\n  ${hits.join('\n  ')}`);
});

test('#1107: the detector catches the measured shapes and passes the safe ones', () => {
  for (const bad of [
    "s.replace(" + BANNED + "(\\s*ci-digest:)/gi, 'x')",
    'export const RE = ' + BANNED + '\\s*x\\s*-->/;',
    '  [' + BANNED + '\\s*SPECKIT START\\s*-->/i],',
  ]) {
    assert.deepEqual(offendingLines(bad), [1], bad);
  }
  for (const ok of ["s.replace(/<[!]--(\\s*x)/gi, '<!--')", 'const R = /^<!-- forked-from/;', "const s = '<!-- x -->';"]) {
    assert.deepEqual(offendingLines(ok), [], ok);
  }
});
