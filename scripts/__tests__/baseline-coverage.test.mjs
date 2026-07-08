// T013 — authenticated-coverage + fail-fast assertions for the DAST baseline (feature 031).
// SC-002 / FR-012. Pure-function tests over synthetic report JSON — no Docker, no live scan.
//
// Rationale: a scan that "passes" while only crawling the public surface (/login, /register, /init) is
// a silent auth failure, not a clean result. assertAuthenticatedCoverage() turns that into a hard
// error; login() fails fast when no credentials are available.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAuthenticatedCoverage, extractCrawledUrls } from '../zap-scan.mjs';
import { login } from '../dast-bff-login.mjs';

// A synthetic ZAP traditional-json report with only public URLs crawled (auth silently failed).
const PUBLIC_ONLY = {
  site: [
    {
      '@name': 'http://mcm-bff-service-nonsecure:3000',
      alerts: [],
      // ZAP records requested URLs across the report; extractCrawledUrls must gather them.
      urls: [
        'http://mcm-bff-service-nonsecure:3000/login',
        'http://mcm-bff-service-nonsecure:3000/register',
        'http://mcm-bff-service-nonsecure:3000/bff-api/auth/init',
      ],
    },
  ],
};

const AUTHENTICATED = {
  site: [
    {
      '@name': 'http://mcm-bff-service-nonsecure:3000',
      alerts: [],
      urls: [
        'http://mcm-bff-service-nonsecure:3000/login',
        'http://mcm-bff-service-nonsecure:3000/bff-api/collections',
      ],
    },
    {
      '@name': 'http://mc-service:3001',
      alerts: [],
      urls: ['http://mc-service:3001/api/v1/collections'],
    },
  ],
};

test('extractCrawledUrls flattens all requested URLs across sites', () => {
  const urls = extractCrawledUrls(AUTHENTICATED);
  assert.ok(urls.includes('http://mcm-bff-service-nonsecure:3000/bff-api/collections'));
  assert.ok(urls.includes('http://mc-service:3001/api/v1/collections'));
});

test('assertAuthenticatedCoverage throws when only public URLs were crawled (silent auth failure)', () => {
  assert.throws(
    () => assertAuthenticatedCoverage(PUBLIC_ONLY),
    /authenticated|protected|auth/i,
    'a public-only crawl must be treated as a failed authenticated session, not a clean pass',
  );
});

test('assertAuthenticatedCoverage passes when protected endpoints were crawled', () => {
  assert.doesNotThrow(() => assertAuthenticatedCoverage(AUTHENTICATED));
});

test('login() fails fast when no credentials are available (FR-012)', async () => {
  await assert.rejects(
    () => login({ kcBase: 'http://localhost:8099', bffBase: 'http://localhost:8082', realm: 'grumpyrobot', clientId: 'movie-collection-manager', redirectUri: 'http://localhost:8082/auth-callback', user: null, pass: null }),
    /DAST_TEST_USER|credential|log in/i,
  );
});
