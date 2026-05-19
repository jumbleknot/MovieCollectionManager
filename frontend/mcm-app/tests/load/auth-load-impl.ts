/**
 * k6 load test implementation for auth endpoints (T-123)
 *
 * Acceptance thresholds (SC-007):
 * - 99.5% login success rate
 * - p95 login response < 5000ms
 * - p95 profile response < 2000ms
 * - Max concurrent users: 500
 * - Login requests: ≤100/minute
 *
 * Run:
 *   k6 run tests/load/auth-load-impl.js
 *   (compile this file first with: npx esbuild tests/load/auth-load-impl.ts --bundle --outfile=tests/load/auth-load-impl.js)
 */

// k6 uses a special import syntax — not Node.js
// @ts-ignore k6 runtime
import http from 'k6/http';
// @ts-ignore k6 runtime
import { check, sleep } from 'k6';
// @ts-ignore k6 runtime
import { Rate, Trend } from 'k6/metrics';

const loginFailRate = new Rate('login_failures');
const loginDuration = new Trend('login_duration');
const profileDuration = new Trend('profile_duration');

export const options = {
  stages: [
    { duration: '30s', target: 50 },   // ramp up to 50 users
    { duration: '2m', target: 200 },   // ramp up to 200 users
    { duration: '3m', target: 500 },   // peak load: 500 concurrent
    { duration: '1m', target: 0 },     // ramp down
  ],
  thresholds: {
    login_failures: ['rate<0.005'],        // < 0.5% failure rate
    login_duration: ['p(95)<5000'],        // p95 < 5s
    profile_duration: ['p(95)<2000'],      // p95 < 2s
    http_req_failed: ['rate<0.005'],       // overall < 0.5% HTTP failure
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8081';

export default function () {
  // Simulate login via BFF (code exchange — requires valid PKCE codes in real test)
  // In load testing, we typically use a pre-authenticated session or stub endpoint
  const loginRes = http.post(
    `${BASE_URL}/bff-api/auth/login`,
    JSON.stringify({
      code: 'load-test-code',
      codeVerifier: 'load-test-verifier',
      redirectUri: 'mcm-app://native-auth-callback',
    }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'login' },
    }
  );

  loginFailRate.add(loginRes.status !== 200);
  loginDuration.add(loginRes.timings.duration);

  check(loginRes, {
    'login status is 200': (r) => r.status === 200,
  });

  if (loginRes.status === 200) {
    // Simulate profile fetch after login
    const profileRes = http.get(`${BASE_URL}/bff-api/auth/user`, {
      headers: { Cookie: loginRes.headers['Set-Cookie'] ?? '' },
      tags: { name: 'profile' },
    });

    profileDuration.add(profileRes.timings.duration);

    check(profileRes, {
      'profile status is 200': (r) => r.status === 200,
    });
  }

  sleep(1);
}
