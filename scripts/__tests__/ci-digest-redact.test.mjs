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

// ================================================================================================
// Redaction bypasses found by adversarial review. Each published a real secret or the forge host.
// ================================================================================================

test('(f) host matching is CASE-INSENSITIVE — DNS is, and CI output uppercases hostnames', () => {
  // env dumps (REGISTRY_HOST=BEELINK...), JVM stack traces and Windows tooling routinely uppercase.
  for (const variant of [tsNetHost('box.tailz9x8w7'), 'box.tailz9x8w7' + '.TS' + '.NET', 'BOX.TAILZ9X8W7' + '.Ts' + '.Net']) {
    const out = redactForPublication(`GET http://${variant}/api`);
    assert.match(out, /<forge>/, `not redacted: ${variant}`);
    assert.equal(/tailz9x8w7/i.test(out), false, `host survived: ${variant}`);
  }
});

test('(g) the forge\'s OWN `token <cred>` auth scheme is redacted', () => {
  // This is the scheme both scripts in this feature use, so it is exactly what a captured `curl -v`,
  // an undici debug dump, or a `set -x` trace in a collected log will contain. A raw forge PAT
  // matches none of secret-scan's four narrow rules, so the fail-closed pass would NOT catch it.
  const pat = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
  const out = redactForPublication(`Authorization: token ${pat}`);
  assert.equal(out.includes(pat), false, 'the forge auth token was published verbatim');
  assert.match(out, /<redacted>/);
});

test('(h) tailnet CGNAT addresses are redacted', () => {
  // 100.64.0.0/10. CI logs carry resolved IPs constantly — docker inspect, ECONNREFUSED, getaddrinfo.
  for (const ip of ['100.101.102.103', '100.64.0.1', '100.127.255.254']) {
    const out = redactForPublication(`connect ECONNREFUSED ${ip}:3000`);
    assert.equal(out.includes(ip), false, `tailnet IP survived: ${ip}`);
  }
});

test('(h2) a NON-tailnet 100.x address is left alone', () => {
  // 100.63/100.128 are outside the CGNAT range and are ordinary public addresses.
  for (const ip of ['100.63.255.255', '100.128.0.1', '10.0.0.1']) {
    assert.match(redactForPublication(`host ${ip}`), new RegExp(ip.replace(/\./g, '\\.')));
  }
});

test('(i) placeholder detection is per-LABEL, not a substring match on the whole host', () => {
  // `myexamplebox.<random>.ts.net` contains "example" and so was published verbatim.
  const sneaky = 'myexamplebox.tailz9x8w7' + '.ts' + '.net';
  const out = redactForPublication(`GET http://${sneaky}/api`);
  assert.match(out, /<forge>/, 'a real host escaped by embedding a placeholder word');
  assert.equal(out.includes('tailz9x8w7'), false);
});

test('(i2) genuine documentation placeholders are still left alone', () => {
  for (const ok of ['forge.tailnet-example.ts.net', 'server.tailnet.ts.net', 'example-host.ts.net']) {
    assert.match(redactForPublication(`see ${ok}`), new RegExp(ok.replace(/\./g, '\\.')));
  }
});

test('(j) a credential containing special characters is still redacted', () => {
  const pw = 'P@ssw0rd!Very#Long$Value';
  const out = redactForPublication(`password: ${pw}`);
  assert.equal(out.includes(pw), false, 'a special-character credential was published');
});

// ================================================================================================
// Security hardening — broaden the fail-closed backstop beyond the 4 repo-specific shapes.
// ================================================================================================

test('(k) high-signal token prefixes are caught by the fail-closed pass (dropped, not published)', () => {
  // The 4 named secret-scan shapes miss provider PATs. These prefixes are unambiguous (near-zero
  // false positive), so a residual one after redaction must WITHHELD the excerpt.
  for (const [label, tok] of [
    ['github classic', 'ghp_' + 'A'.repeat(36)],
    ['github fine-grained', 'github_pat_' + 'B'.repeat(60)],
    ['gitlab', 'glpat-' + 'C'.repeat(20)],
    ['slack', 'xoxb-' + '1'.repeat(20)],
    ['aws akid', 'AKIA' + 'D'.repeat(16)],
    ['pem', '-----BEGIN RSA PRIVATE KEY-----'],
  ]) {
    const r = redactExcerpt(`log line\ntoken leaked ${tok}\nmore`);
    assert.equal(r.withheld, true, `${label} not withheld`);
    assert.equal(r.text.includes(tok), false, `${label} leaked in the withheld notice`);
  }
});

test('(l) a broadened key=value assignment is redacted (more key names, url-encoded)', () => {
  for (const line of ['SIGNING_KEY=abcdef0123456789abcdef', 'FOO_PAT: qwertyuiop1234567890', 'credential=verylongsecretvalue123']) {
    const out = redactForPublication(line);
    assert.match(out, /<redacted>/, `not redacted: ${line}`);
  }
});

test('(m) a plain git SHA is NOT withheld (avoid false-positive that drops every log)', () => {
  // Long hex is a git SHA, ubiquitous in CI logs. It must NOT trip the backstop.
  const r = redactExcerpt('merged c2c3c29593fa94b3fd6d2b90ba7aaa94ddbc4596 into main');
  assert.equal(r.withheld, false, 'a git SHA was mistaken for a secret — this would drop most logs');
  assert.match(r.text, /c2c3c295/);
});
