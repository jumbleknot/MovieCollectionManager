/**
 * BFF test client (T004).
 *
 * A plain axios instance targeting the running BFF, plus a helper to capture the
 * session cookie from a `set-cookie` response for replay on later requests. No
 * cookie-jar dependency (`axios-cookiejar-support`/`tough-cookie` are NOT
 * installed and must not be added) — cookies are captured/replayed manually, the
 * same approach feature 003's probe scripts use.
 *
 * `validateStatus: () => true` so tests assert on any status (401/403/4xx/5xx)
 * without axios throwing.
 */
import axios, { type AxiosInstance } from 'axios';

const BASE = process.env.BFF_BASE_URL ?? 'http://localhost:8081';

export function createBffClient(): AxiosInstance {
  return axios.create({ baseURL: BASE, withCredentials: true, validateStatus: () => true });
}

/**
 * Extract the session cookie(s) from a login/refresh response, formatted for the
 * `Cookie` request header on subsequent calls.
 *
 * Usage:
 *   const bff = createBffClient();
 *   const login = await bff.post('/bff-api/auth/login', payload);
 *   const cookie = cookieHeaderFrom(login);
 *   await bff.get('/bff-api/auth/user', { headers: { Cookie: cookie } });
 */
export function cookieHeaderFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers['set-cookie'] as string[] | undefined;
  return (setCookie ?? []).map((c) => c.split(';')[0]).join('; ');
}
