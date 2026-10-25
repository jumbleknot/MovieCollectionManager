/**
 * @jest-environment node
 */
/**
 * Spec 083 T010 (item #843) — the origin a BFF route sees behind the TLS-terminating proxy.
 *
 * In production Cloudflare terminates TLS and `cloudflared` reaches the BFF over plain HTTP.
 * `@expo/server`'s express adapter builds each request URL from `req.protocol` and the raw `Host`
 * header, so without express's `trust proxy` every route saw `http://` — and the backup consent
 * route sent Keycloak `redirect_uri=http://mcm.…/bff-api/backups/consent`, which the client does
 * not register ("Invalid parameter: redirect_uri", measured 2026-10-25).
 *
 * Boots the REAL `server.js` twice, as `bff-server-adapter.test.ts` does (copied next to an empty
 * `dist/client`, with the Expo handler stubbed to echo the origin it was given): once as production
 * runs it (`TRUSTED_PROXY=true`), once without, which must keep ignoring a client-supplied scheme.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const APP_ROOT = resolve(__dirname, '..', '..');
const STUB = join(__dirname, 'fixtures', 'expo-adapter-stub.cjs');

interface Server {
  port: number;
  child: ChildProcess;
  dir: string;
}

async function boot(extraEnv: Record<string, string>): Promise<Server> {
  const dir = mkdtempSync(join(tmpdir(), 'mcm-bff-proxy-'));
  cpSync(join(APP_ROOT, 'server.js'), join(dir, 'server.js'));
  cpSync(join(APP_ROOT, 'web-security-headers.js'), join(dir, 'web-security-headers.js'));
  mkdirSync(join(dir, 'dist', 'client'), { recursive: true });
  const port = 33000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ['-r', STUB, join(dir, 'server.js')], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      NODE_PATH: join(APP_ROOT, 'node_modules'),
      NODE_ENV: 'production',
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (c: Buffer) => (output += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (output += c.toString()));
  const deadline = Date.now() + 15_000;
  while (!output.includes('MCM BFF listening')) {
    if (child.exitCode !== null) throw new Error(`server.js exited with ${child.exitCode}:\n${output}`);
    if (Date.now() > deadline) throw new Error(`server.js did not start within 15 s:\n${output}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return { port, child, dir };
}

function stop(server: Server | undefined): void {
  server?.child.kill('SIGTERM');
  if (server) rmSync(server.dir, { recursive: true, force: true });
}

/** The origin the Expo handler was given, for a request carrying these headers. */
function originSeen(server: Server, headers: Record<string, string>): Promise<string> {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.port, method: 'GET', path: '/bff-api/backups/consent?start', headers },
      (r) => {
        r.resume();
        r.on('end', () => res(String(r.headers['x-test-origin'])));
      },
    );
    req.on('error', rej);
    req.end();
  });
}

describe('behind the proxy (TRUSTED_PROXY=true, as production runs)', () => {
  let server: Server;
  beforeAll(async () => {
    server = await boot({ TRUSTED_PROXY: 'true' });
  }, 20_000);
  afterAll(() => stop(server));

  it('takes the public scheme from X-Forwarded-Proto', async () => {
    await expect(
      originSeen(server, { host: 'mcm.example.test', 'x-forwarded-proto': 'https' }),
    ).resolves.toBe('https://mcm.example.test');
  });

  it('keeps http when the proxy says nothing', async () => {
    await expect(originSeen(server, { host: 'mcm.example.test' })).resolves.toBe('http://mcm.example.test');
  });

  it('never takes the host from X-Forwarded-Host', async () => {
    await expect(
      originSeen(server, {
        host: 'mcm.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'attacker.test',
      }),
    ).resolves.toBe('https://mcm.example.test');
  });
});

describe('without a trusted proxy (TRUSTED_PROXY unset)', () => {
  let server: Server;
  beforeAll(async () => {
    server = await boot({});
  }, 20_000);
  afterAll(() => stop(server));

  it('ignores a client-supplied X-Forwarded-Proto', async () => {
    await expect(
      originSeen(server, { host: 'mcm.example.test', 'x-forwarded-proto': 'https' }),
    ).resolves.toBe('http://mcm.example.test');
  });
});
