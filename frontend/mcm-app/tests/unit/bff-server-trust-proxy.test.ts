/**
 * No `@jest-environment node` here (feature 087, T043): see the same note in
 * `bff-server-adapter.test.ts`. Plain `jest-environment-node` fails every suite under Jest 30.4+ with
 * jest-expo's lazy globals; the preset's environment is Node-based and skips them.
 */
/**
 * Spec 083 T010 (item #843), feature 087 — the URL a BFF route receives behind the TLS-terminating
 * proxy, through the REAL `expo-server` adapter. Nothing is stubbed on this path.
 *
 * In production Cloudflare terminates TLS and `cloudflared` reaches the BFF over plain HTTP. A route
 * that derives a callback from `new URL(request.url).origin` needs the PUBLIC scheme: without it the
 * backup consent route sent Keycloak `redirect_uri=http://mcm.…/bff-api/backups/consent`, which the
 * client does not register ("Invalid parameter: redirect_uri", measured 2026-10-25).
 *
 * This test used to run against a stub that echoed the origin it computed itself, so it could not see
 * what the adapter really does. `expo-server` takes the scheme from the socket and ignores `req.protocol`,
 * which is why `server.js` hands it an absolute URL (research R1). Removing that wrapper must turn the
 * `https` rows red.
 *
 * Boots real `server.js` beside `fixtures/real-adapter-build`, a minimal `dist/server` holding one
 * API route that returns `request.url`. If an SDK changes the manifest shape this fails, and that is the
 * intended prompt. `express` and `expo-server` resolve from this package's `node_modules` via NODE_PATH.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const APP_ROOT = resolve(__dirname, '..', '..');
const FIXTURE_BUILD = join(__dirname, 'fixtures', 'real-adapter-build');
const ROUTE = '/bff-api/echo-url?start=1&tag=a';

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
  cpSync(FIXTURE_BUILD, join(dir, 'dist', 'server'), { recursive: true });
  const port = 33000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [join(dir, 'server.js')], {
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

/** The URL the route received, for a request carrying these headers. Anything but a 200 rejects. */
function urlSeen(server: Server, headers: Record<string, string>): Promise<string> {
  return new Promise((res, rej) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.port, method: 'GET', path: ROUTE, headers },
      (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (body += c));
        r.on('end', () => {
          if (r.statusCode !== 200) {
            rej(new Error(`expected 200 from the fixture route, got ${r.statusCode}: ${body}`));
            return;
          }
          res((JSON.parse(body) as { url: string }).url);
        });
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
    await expect(urlSeen(server, { host: 'mcm.example.test', 'x-forwarded-proto': 'https' })).resolves.toBe(
      `https://mcm.example.test${ROUTE}`,
    );
  });

  it('keeps http when the proxy says nothing', async () => {
    await expect(urlSeen(server, { host: 'mcm.example.test' })).resolves.toBe(`http://mcm.example.test${ROUTE}`);
  });

  it('never takes the host from X-Forwarded-Host', async () => {
    await expect(
      urlSeen(server, {
        host: 'mcm.example.test',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'attacker.test',
      }),
    ).resolves.toBe(`https://mcm.example.test${ROUTE}`);
  });
});

describe('without a trusted proxy (TRUSTED_PROXY unset)', () => {
  let server: Server;
  beforeAll(async () => {
    server = await boot({});
  }, 20_000);
  afterAll(() => stop(server));

  it('ignores a client-supplied X-Forwarded-Proto', async () => {
    await expect(urlSeen(server, { host: 'mcm.example.test', 'x-forwarded-proto': 'https' })).resolves.toBe(
      `http://mcm.example.test${ROUTE}`,
    );
  });
});
