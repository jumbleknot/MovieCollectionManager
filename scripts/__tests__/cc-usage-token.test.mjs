// Feature 105 — Keycloak client-credentials token acquisition and caching
// (contracts/store-http.md "Token acquisition"; research R18; US1-AC4; FR-014, FR-015).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_ID, TokenError, obtainAccessToken, recordStoreRejection, tokenState } from '../lib/cc-usage/obtain-access-token.mjs';
import { backoffActive, paths } from '../lib/cc-usage/local-state.mjs';

const TOKEN_URL = 'http://kc.invalid:19099/realms/grumpyrobot/protocol/openid-connect/token';
const SECRET = 'S3CRET-client-secret-value';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-usage-token-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A fake token endpoint: issues tok-1, tok-2, … with the given lifetime. */
function fakeKeycloak({ expiresIn = 3600, status = 200, fail = false } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: new URLSearchParams(init.body) });
    if (fail) throw new TypeError('fetch failed');
    await new Promise((r) => setTimeout(r, 5));
    if (status !== 200) return new Response(JSON.stringify({ error: 'invalid_client' }), { status });
    return new Response(JSON.stringify({ access_token: `tok-${calls.length}`, expires_in: expiresIn, token_type: 'Bearer' }), { status: 200 });
  };
  return { fetch, calls };
}

const get = (dir, kc, now) => obtainAccessToken({ configDir: dir, tokenUrl: TOKEN_URL, clientSecret: SECRET, fetch: kc.fetch, now });

test('posts the client-credentials grant with the secret in the form body only', () => withDir(async (dir) => {
  const kc = fakeKeycloak();
  const t = await get(dir, kc, 1_000_000);
  assert.equal(t.token, 'tok-1');
  assert.equal(kc.calls.length, 1);
  const c = kc.calls[0];
  assert.equal(c.url, TOKEN_URL, 'the URL is used as given — no secret appended');
  assert.equal(c.init.method, 'POST');
  assert.match(String(new Headers(c.init.headers).get('content-type')), /application\/x-www-form-urlencoded/);
  assert.equal(c.body.get('grant_type'), 'client_credentials');
  assert.equal(c.body.get('client_id'), CLIENT_ID);
  assert.equal(CLIENT_ID, 'dev-usage-capture');
  assert.equal(c.body.get('client_secret'), SECRET);
  assert.ok(c.init.signal, 'the request carries a timeout signal');
}));

test('caches the token in token.json (0600) and reuses it until 60 s before expiry', () => withDir(async (dir) => {
  const kc = fakeKeycloak({ expiresIn: 3600 });
  const t0 = 1_000_000;
  await get(dir, kc, t0);
  assert.equal(statSync(paths(dir).token).mode & 0o777, 0o600);
  assert.equal((await get(dir, kc, t0 + 3000_000)).token, 'tok-1', 'reused well inside its lifetime');
  assert.equal(kc.calls.length, 1);
  assert.equal((await get(dir, kc, t0 + 3540_000 + 1)).token, 'tok-2', 'refreshed within 60 s of expiry');
  assert.equal(kc.calls.length, 2);
  const st = tokenState(dir, { now: t0 + 3540_000 + 2 });
  assert.equal(st.state, 'valid');
  assert.ok(st.validUntil > t0 + 3540_000);
}));

test('two concurrent callers with an expired cache both end with a valid token', () => withDir(async (dir) => {
  const kc = fakeKeycloak();
  const [a, b] = await Promise.all([get(dir, kc, 5_000), get(dir, kc, 5_000)]);
  assert.match(a.token, /^tok-\d$/);
  assert.match(b.token, /^tok-\d$/);
  const cached = JSON.parse(readFileSync(paths(dir).token, 'utf8'));
  assert.match(cached.access_token, /^tok-\d$/, 'token.json is a whole, parseable write');
}));

for (const status of [400, 401]) {
  test(`${status} from the token endpoint → client credential rejected`, () => withDir(async (dir) => {
    const kc = fakeKeycloak({ status });
    await assert.rejects(get(dir, kc, 1), (e) => e instanceof TokenError && e.kind === 'rejected');
    assert.equal(tokenState(dir, { now: 2 }).state, 'rejected');
    assert.equal(existsSync(paths(dir).token), false);
  }));
}

test('a network failure writes back-off', () => withDir(async (dir) => {
  const kc = fakeKeycloak({ fail: true });
  await assert.rejects(get(dir, kc, 10_000), (e) => e instanceof TokenError && e.kind === 'network');
  assert.equal(backoffActive(dir, { now: 10_001 }), true);
}));

test('a store 401 with a fresh token is recorded distinctly (signing-key rotation)', () => withDir(async (dir) => {
  const kc = fakeKeycloak();
  await get(dir, kc, 1_000);
  recordStoreRejection(dir, 2_000);
  assert.equal(tokenState(dir, { now: 3_000 }).state, 'store-rejects');
}));

test('neither the secret nor a token ever reaches the log or a thrown message', () => withDir(async (dir) => {
  const messages = [];
  // Far-apart times so every call goes to the endpoint: success, then 401, then a network failure.
  const cases = [[fakeKeycloak(), 0], [fakeKeycloak({ status: 401 }), 10 * 3600_000], [fakeKeycloak({ fail: true }), 20 * 3600_000]];
  for (const [kc, at] of cases) {
    try {
      await get(dir, kc, at);
    } catch (e) {
      messages.push(String(e.message), String(e.stack));
    }
  }
  assert.equal(messages.length, 4, 'exactly the rejected and the network case threw (the first call succeeded)');
  const logText = existsSync(paths(dir).log) ? readFileSync(paths(dir).log, 'utf8') : '';
  const stateText = existsSync(paths(dir).tokenState) ? readFileSync(paths(dir).tokenState, 'utf8') : '';
  for (const text of [logText, stateText, ...messages]) {
    assert.ok(!text.includes(SECRET), 'the client secret leaked');
    assert.ok(!/tok-\d/.test(text), 'an access token leaked');
  }
}));
