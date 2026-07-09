#!/usr/bin/env node
// Headless BFF login helper for the DAST scan (feature 031, T006 / C2).
// Contract: specs/031-dast-zap-scanning/contracts/zap-scan-contract.md.
//
// WHY: the CI `dast` job runs in a plain node:22 container with no browser, so it cannot reuse the
// Playwright `global-setup` (which drives the Keycloak popup). This performs the OAuth
// Authorization-Code + PKCE flow directly over HTTP against Keycloak — no browser — to obtain the
// three `mcm_*` session cookies the ZAP `bff` context needs:
//
//   1. GET  Keycloak /auth        → capture the login-form action URL + the KC auth-session cookies
//   2. POST the form action       → username/password → 302 redirect carrying the auth `code`
//   3. POST BFF /bff-api/auth/login { code, codeVerifier, redirectUri } → Set-Cookie mcm_*
//
// The cookies are written to security/zap/reports/.auth.local.json (gitignored). Credentials come
// from env (DAST_* defaulting to E2E_*); nothing secret is logged (FR-013, FR-015, SC-008).
//
// Usage: node scripts/dast-bff-login.mjs [--out <path>]

import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function envOrE2E(dastName, e2eName, fallback) {
  return process.env[dastName] ?? process.env[e2eName] ?? fallback ?? null;
}

export function config() {
  return {
    kcBase: process.env.DAST_KC_BASE_URL ?? 'http://localhost:8099',
    bffBase: process.env.DAST_BFF_BASE_URL ?? 'http://localhost:8082',
    realm: process.env.DAST_REALM ?? 'grumpyrobot',
    clientId: process.env.DAST_BFF_CLIENT_ID ?? 'movie-collection-manager',
    redirectUri: process.env.DAST_REDIRECT_URI ?? 'http://localhost:8082/auth-callback',
    user: envOrE2E('DAST_TEST_USER', 'E2E_TEST_USER'),
    pass: envOrE2E('DAST_TEST_PASSWORD', 'E2E_TEST_PASSWORD'),
  };
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pkcePair() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Extract the mcm_* cookie name=value pairs from a set of Set-Cookie header strings. */
function parseMcmCookies(setCookieHeaders) {
  const out = {};
  for (const sc of setCookieHeaders) {
    const m = /^\s*(mcm_[a-z_]+)=([^;]+)/.exec(sc);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Run the full headless login and return { mcm_access_token, mcm_refresh_token, mcm_session_id }.
 * Throws with a clear message (never a credential) if any step fails — the caller must fail fast
 * rather than proceed to a public-only scan (FR-012).
 */
export async function login(cfg = config()) {
  if (!cfg.user || !cfg.pass) {
    throw new Error('DAST_TEST_USER / DAST_TEST_PASSWORD (or E2E_* equivalents) must be set — cannot log in to the BFF.');
  }
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(12));

  // 1. GET the authorize page.
  const authUrl = new URL(`${cfg.kcBase}/realms/${cfg.realm}/protocol/openid-connect/auth`);
  authUrl.search = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: 'openid',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  const authRes = await fetch(authUrl, { redirect: 'manual' });
  if (authRes.status !== 200) {
    throw new Error(`Keycloak authorize returned HTTP ${authRes.status} (expected the login form). Is the realm/client "${cfg.clientId}" configured and the redirect_uri allowed?`);
  }
  const html = await authRes.text();
  const actionMatch = /<form[^>]*\saction="([^"]+)"/i.exec(html);
  if (!actionMatch) {
    throw new Error('Could not find the Keycloak login-form action — the authorize response was not the expected login page (already-authenticated session? unexpected theme?).');
  }
  const formAction = actionMatch[1].replace(/&amp;/g, '&');
  const kcCookies = authRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

  // 2. POST credentials to the form action; capture the redirect carrying ?code=.
  const loginRes = await fetch(formAction, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: kcCookies,
    },
    body: new URLSearchParams({ username: cfg.user, password: cfg.pass, credentialId: '' }).toString(),
  });
  const location = loginRes.headers.get('location');
  if (!location || (loginRes.status !== 302 && loginRes.status !== 303)) {
    throw new Error(`Keycloak login did not redirect (HTTP ${loginRes.status}) — credentials rejected or an action (verify email/OTP) is required for the test user.`);
  }
  const code = new URL(location).searchParams.get('code');
  if (!code) {
    throw new Error('Keycloak redirect did not carry an authorization code — login likely failed.');
  }

  // 3. Exchange the code at the BFF for the mcm_* session cookies.
  const bffRes = await fetch(`${cfg.bffBase}/bff-api/auth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, codeVerifier: verifier, redirectUri: cfg.redirectUri }),
  });
  if (bffRes.status !== 200) {
    throw new Error(`BFF /bff-api/auth/login returned HTTP ${bffRes.status} — code exchange failed (redirect_uri mismatch? Redis/session store down?).`);
  }
  const cookies = parseMcmCookies(bffRes.headers.getSetCookie());
  if (!cookies.mcm_access_token || !cookies.mcm_session_id) {
    throw new Error('BFF login succeeded but did not set the expected mcm_* cookies — cannot establish a BFF scan session.');
  }
  return cookies;
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx !== -1 ? args[outIdx + 1] : resolve(REPO_ROOT, 'security/zap/reports/.auth.local.json');

  const cookies = await login();
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(cookies, null, 2));
  // Log the outcome, never the values.
  console.log(`[dast-bff-login] wrote ${Object.keys(cookies).length} mcm_* cookies to ${outPath.replace(REPO_ROOT, '.')}`);
}

// Run main() only when invoked directly (not when imported by a test).
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[dast-bff-login] FAILED: ${err.message}`);
    process.exit(1);
  });
}
