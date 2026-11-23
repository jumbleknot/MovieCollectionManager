// Item #1106 — a secret gate must never print the secret it caught.
//
// WHY THIS GUARD EXISTS. Until item #1106, `secret-scan.mjs` printed a `sample` for every finding: the
// first 16 characters of most matches, 40 for the E2E fallback rule, and the WHOLE captured field for
// cassette auth fields. Those lines go to the CI log and from there into the failure digest posted on
// the pull request — so the gate published part of a real key at exactly the moment it did its job.
// Found by the BELAY port, which prints `file:line: rule: credential-shaped value (withheld)`.
//
// This runs the REAL scanner end to end against a throwaway git repository holding planted values, and
// asserts that no 6+ character run of any planted value reaches stdout or stderr. A check on
// `scanText()`'s return shape alone would miss a print path that formats the match some other way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanText } from '../secret-scan.mjs';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Built at runtime so no key-shaped literal sits in this file (the tree-wide scan would flag it).
const KEY = 'sk-ant-api03-' + 'Zq7'.repeat(32);
// Values share no 6-char run with any path or message the scanner prints legitimately.
const CASSETTE_VALUE = 'Bearer ' + 'Wx4vQp'.repeat(6);
const FALLBACK = 'Jk8rTn'.repeat(5);

/** Every 6-character window of `value` that is not purely a generic prefix. */
function windows(value) {
  const out = [];
  for (let i = 0; i + 6 <= value.length; i++) out.push(value.slice(i, i + 6));
  return out;
}

function plantedRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-1106-'));
  mkdirSync(join(dir, 'scripts'));
  copyFileSync(join(SCRIPTS, 'secret-scan.mjs'), join(dir, 'scripts', 'secret-scan.mjs'));
  mkdirSync(join(dir, 'tests', 'golden', 'cassettes'), { recursive: true });
  writeFileSync(join(dir, 'leak.ts'), `// line 1\nconst k = "${KEY}";\n`);
  writeFileSync(join(dir, 'tests', 'golden', 'cassettes', 'c.json'), `{"authorization": "${CASSETTE_VALUE}"}\n`);
  // Name split so the fallback SHAPE never appears joined in this file (the tree-wide scan would flag it).
  writeFileSync(join(dir, 'setup.ts'), 'const p = process.env.E2E_TEST_' + `PASSWORD ?? '${FALLBACK}';\n`);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

test('#1106: the real scan reports file:line and rule, and withholds every planted value', () => {
  const dir = plantedRepo();
  try {
    const r = spawnSync(process.execPath, [join(dir, 'scripts', 'secret-scan.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 1, `the planted values must fail the scan:\n${r.stdout}${r.stderr}`);
    const out = `${r.stdout}\n${r.stderr}`;

    assert.match(out, /leak\.ts:2: anthropic-api-key: credential-shaped value \(withheld\)/);
    assert.match(out, /tests\/golden\/cassettes\/c\.json:1: cassette-auth-field: /);
    assert.match(out, /setup\.ts:1: e2e-credential-fallback-literal: /);

    // `sk-ant` and `Bearer` are generic prefixes, not secret material; skip windows inside them.
    const secretParts = [KEY.slice('sk-ant-api03-'.length), CASSETTE_VALUE.slice('Bearer '.length), FALLBACK];
    for (const part of secretParts) {
      for (const w of windows(part)) {
        assert.ok(!out.includes(w), `output leaked "${w}" from a planted value:\n${out}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#1106: scanText returns location and rule only — no field carries matched text', () => {
  const hits = scanText('tests/golden/cassettes/x.json', `\n{"authorization": "${CASSETTE_VALUE}"}\nconst k = "${KEY}";`);
  assert.ok(hits.length >= 2);
  for (const h of hits) {
    assert.deepEqual(Object.keys(h).sort(), ['line', 'rule']);
  }
  assert.deepEqual(hits.find((h) => h.rule === 'cassette-auth-field').line, 2);
  assert.deepEqual(hits.find((h) => h.rule === 'anthropic-api-key').line, 3);
});

test('#1106: the topology gates print location, not the matched host', () => {
  for (const [file, banned] of [
    ['check-komodo-sync.mjs', /\$\{f\.sample\}|sample: m\[0\]/],
    ['check-topology-scrub.mjs', /\$\{f\.host\}/],
  ]) {
    const src = readFileSync(join(SCRIPTS, file), 'utf8');
    assert.doesNotMatch(src, banned, `${file} prints the value it matched`);
  }
});
