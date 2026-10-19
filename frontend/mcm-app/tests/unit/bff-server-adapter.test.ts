/**
 * @jest-environment node
 */
/**
 * Feature 081 US6 (T044) — the express layer of `server.js`, the BFF's production entrypoint.
 *
 * `server.js` is the only place the BFF touches express, and before this file nothing below the
 * web E2E suite exercised it: the unit tier imports TS modules, the integration tier calls route
 * handlers, and both bypass `server.js`. An express major (4 → 5: path-to-regexp v8, serve-static 2,
 * router 2) changes exactly the behaviours pinned here:
 *
 *   1. the catch-all forwards EVERY method and path, query string intact, to the Expo handler;
 *   2. a malformed percent-encoded path is rejected with 400 BEFORE the Expo handler sees it;
 *   3. static files are served from `dist/client` with the production cache headers, and a
 *      root dotfile is never served from disk;
 *   4. the header middleware stamps `X-BFF-Source` and the baseline headers on every response
 *      class, path-scopes the web CSP away from `/bff-api`, and `X-Powered-By` is never sent.
 *
 * The REAL `server.js` and `web-security-headers.js` are copied into a temp directory next to a
 * fixture `dist/client`, and booted with `node -r expo-adapter-stub.cjs` (see that file for why).
 * `express` resolves from this package's own `node_modules` via NODE_PATH, so the version under
 * test is the one in package.json.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const APP_ROOT = resolve(__dirname, '..', '..');
const STUB = join(__dirname, 'fixtures', 'expo-adapter-stub.cjs');
const PORT = 31000 + Math.floor(Math.random() * 2000);

let dir: string;
let child: ChildProcess;
let output = '';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw node:http so a malformed path reaches the server byte-for-byte (fetch would normalise it). */
function send(method: string, path: string): Promise<Reply> {
  return new Promise((res, rej) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, method, path }, (r) => {
      let body = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => (body += c));
      r.on('end', () => res({ status: r.statusCode ?? 0, headers: r.headers, body }));
    });
    req.on('error', rej);
    req.end();
  });
}

async function waitForListening(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server.js exited with ${child.exitCode} before listening:\n${output}`);
    }
    if (output.includes('MCM BFF listening')) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server.js did not start within 15 s:\n${output}`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcm-bff-adapter-'));
  cpSync(join(APP_ROOT, 'server.js'), join(dir, 'server.js'));
  cpSync(join(APP_ROOT, 'web-security-headers.js'), join(dir, 'web-security-headers.js'));
  mkdirSync(join(dir, 'dist', 'client', 'assets'), { recursive: true });
  mkdirSync(join(dir, 'dist', 'client', '.hidden'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'client', 'assets', 'app.js'), 'console.log("static");');
  writeFileSync(join(dir, 'dist', 'client', '.env'), 'SECRET=never-served');
  writeFileSync(join(dir, 'dist', 'client', '.hidden', 'file.txt'), 'inside a dot-directory');

  child = spawn(process.execPath, ['-r', STUB, join(dir, 'server.js')], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_PATH: join(APP_ROOT, 'node_modules'),
      NODE_ENV: 'production',
      PORT: String(PORT),
      BFF_SOURCE: 'adapter-test',
      EXPO_PUBLIC_KEYCLOAK_URL: 'http://keycloak.test:8099',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  await waitForListening();
}, 20_000);

afterAll(() => {
  child?.kill('SIGTERM');
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('server.js — the catch-all route', () => {
  it.each([
    ['GET', '/'],
    ['GET', '/collections/abc/movies/def'],
    ['POST', '/bff-api/backups/tick'],
    ['PUT', '/bff-api/collections/abc'],
    ['DELETE', '/bff-api/collections/abc/movies/def'],
    ['PATCH', '/bff-api/settings'],
  ])('forwards %s %s to the Expo handler unchanged', async (method, path) => {
    const r = await send(method, path);
    expect(r.status).toBe(200);
    expect(r.headers['x-test-reached-handler']).toBe('1');
    expect(JSON.parse(r.body)).toEqual({ method, url: path });
  });

  it('passes the raw query string through, bracket syntax included', async () => {
    const path = '/bff-api/movies?collectionId=abc&sort[field]=title&tag=a&tag=b';
    const r = await send('GET', path);
    expect(JSON.parse(r.body)).toEqual({ method: 'GET', url: path });
  });

  it('rejects a malformed percent-encoded path with 400 before the Expo handler', async () => {
    const r = await send('GET', '/bff-api/%E0%A4%A');
    expect(r.status).toBe(400);
    expect(r.headers['x-test-reached-handler']).toBeUndefined();
  });
});

describe('server.js — static serving from dist/client', () => {
  it('serves a built asset with the production cache headers, not via the handler', async () => {
    const r = await send('GET', '/assets/app.js');
    expect(r.status).toBe(200);
    expect(r.body).toBe('console.log("static");');
    expect(r.headers['x-test-reached-handler']).toBeUndefined();
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('never serves a root dotfile from disk (it falls through to the handler)', async () => {
    const r = await send('GET', '/.env');
    expect(r.body).not.toContain('never-served');
    expect(r.headers['x-test-reached-handler']).toBe('1');
  });

  // CHARACTERISATION of express 4 / serve-static 1: its dotfiles default IGNORES a dotfile but
  // SERVES a file inside a dot-directory. `dist/client` has no dot-directory today.
  it('serves a file inside a dot-directory', async () => {
    const r = await send('GET', '/.hidden/file.txt');
    expect(r.status).toBe(200);
    expect(r.body).toBe('inside a dot-directory');
  });
});

describe('server.js — the header middleware', () => {
  it.each([
    ['the Expo handler', '/collections'],
    ['a static asset', '/assets/app.js'],
    ['an API route', '/bff-api/auth/user'],
    ['a 400 rejection', '/bff-api/%E0%A4%A'],
  ])('stamps X-BFF-Source and the baseline headers on %s, never X-Powered-By', async (_, path) => {
    const r = await send('GET', path);
    expect(r.headers['x-bff-source']).toBe('adapter-test');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('sends the web CSP (with the env Keycloak origin) outside /bff-api only', async () => {
    const web = await send('GET', '/collections');
    expect(String(web.headers['content-security-policy'])).toContain('http://keycloak.test:8099');
    const api = await send('GET', '/bff-api/auth/user');
    expect(api.headers['content-security-policy']).toBeUndefined();
  });
});
