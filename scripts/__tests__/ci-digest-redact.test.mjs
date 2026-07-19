// Unit tests for the fail-closed publication redactor (feature 042, FR-005 / FR-017).
//
// Runs in CI: guardrails/naming executes `node --test scripts/__tests__/*.test.mjs` (feature 041),
// so this file MUST stay deterministic, offline, token-free and node:-built-ins only.
//
// Planted credentials are assembled from fragments at RUNTIME so the joined value never appears
// verbatim in this file — otherwise scripts/secret-scan.mjs would flag its own test fixture. Same
// trick that script's --selftest uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactForPublication, redactExcerpt, WITHHELD_NOTICE } from '../ci-digest-redact.mjs';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJlLXZhbHVl';
const ANTHROPIC = 'sk-ant-' + 'api03-' + 'A'.repeat(95);
const BEARER = 'Bearer ' + 'q'.repeat(40);
const COOKIE = 'mcm_access_token=' + 'z'.repeat(32);
// A REAL-shaped tailnet host: a random id containing neither "tailnet" nor "example", which is
// exactly what the redactor must rewrite. Assembled from fragments so no contiguous `.ts.net`
// literal appears in this file — scripts/check-topology-scrub.mjs scans the whole tree and cannot
// distinguish an invented host from a real one (by design: it holds no literal to compare against),
// so spelling one out here fails that gate. Do not "tidy" this into a single string.
const tsNetHost = (label) => label + '.ts' + '.net';
const REAL_HOST = tsNetHost('beelink.tailz9x8w7') + ':3000';
const PLACEHOLDER_HOST = 'forge.tailnet-example.ts.net:3000';

test('(a) EVERY occurrence is redacted, not just the first', () => {
  // The trap from research R4: the secret-scan rules carry no /g, so a naive .replace()
  // rewrites only the first match and silently publishes the rest.
  const text = [`token=${JWT}`, `again=${JWT}`, `third=${JWT}`].join('\n');
  const out = redactForPublication(text);
  assert.equal(out.includes(JWT), false, 'a JWT survived redaction');
  assert.equal(out.split('<redacted-jwt>').length - 1, 3, 'expected all 3 occurrences redacted');
});

test('(b) JWT, bearer token, anthropic key and session cookie are all rewritten', () => {
  for (const [label, secret] of [['jwt', JWT], ['bearer', BEARER], ['anthropic', ANTHROPIC], ['cookie', COOKIE]]) {
    const out = redactForPublication(`prefix ${secret} suffix`);
    assert.equal(out.includes(secret), false, `${label} survived redaction`);
    assert.match(out, /prefix .* suffix/, `${label} redaction destroyed surrounding context`);
  }
});

test('(c) a real-shaped tailnet host is rewritten to <forge>', () => {
  const out = redactForPublication(`fetching http://${REAL_HOST}/api/v1/repos/x`);
  assert.equal(out.includes('tailz9x8w7'), false, 'the tailnet host survived');
  assert.match(out, /<forge>/);
  assert.match(out, /\/api\/v1\/repos\/x/, 'the path was destroyed along with the host');
});

test('(c2) placeholder hosts are left alone (they are already safe)', () => {
  const out = redactForPublication(`fetching http://${PLACEHOLDER_HOST}/api`);
  assert.match(out, /tailnet-example/, 'a documentation placeholder was needlessly rewritten');
});

test('(d) FAIL-CLOSED: an excerpt still matching a detection rule after redaction is dropped', () => {
  // The planted value must be one secret-scan DETECTS but this module has no rewrite rule for —
  // that edge disagreement is the whole reason the verification pass exists.
  //
  // The bare object-store credential word assembled below is exactly that: secret-scan's
  // MCM_DEV_CRED rule matches it, while the generic `key: value` rewrite does not (no `:`/`=`
  // follows the word). An earlier version of this test planted `Mcm-dev-...!` after `password:` —
  // which the generic rewrite DID redact, so the test passed for the wrong reason and never
  // exercised the fail-closed branch at all.
  //
  // The value is assembled from fragments and is deliberately NOT spelled out in this comment
  // either: naming it in prose is enough to trip the tree-wide scan. That is exactly how this file
  // first failed the gate.
  const planted = 'minio' + 'secret';
  const result = redactExcerpt(`storage backend up\nusing ${planted} as the key\ndone`);
  assert.equal(result.withheld, true, 'a residual credential match was published instead of withheld');
  assert.equal(result.text, WITHHELD_NOTICE);
  assert.equal(result.text.includes(planted), false, 'the withheld notice leaked the credential');
  assert.ok(result.rule, 'the withheld result should name which rule matched');
});

test('(d2) a clean excerpt passes through unchanged and is NOT withheld', () => {
  const clean = 'FAIL tests/e2e/web/movies.spec.ts:42\n  expected 5 rows, got 4\n';
  const result = redactExcerpt(clean);
  assert.equal(result.withheld, false, 'a clean excerpt was needlessly withheld');
  assert.equal(result.text, clean);
});

test('(d3) an excerpt whose only secret IS redactable survives redaction rather than being dropped', () => {
  // Losing an excerpt is acceptable ONLY when redaction genuinely failed. A redactable secret
  // must be redacted and kept — otherwise fail-closed degenerates into publishing nothing useful.
  const result = redactExcerpt(`connecting with ${JWT}\nassertion failed at line 12`);
  assert.equal(result.withheld, false, 'a fully-redactable excerpt was dropped');
  assert.match(result.text, /assertion failed at line 12/);
  assert.equal(result.text.includes(JWT), false);
});

test('(e) redaction is idempotent — re-redacting already-clean output changes nothing', () => {
  const once = redactForPublication(`${JWT} at http://${REAL_HOST}/x`);
  assert.equal(redactForPublication(once), once);
});
