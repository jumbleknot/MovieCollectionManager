// Shared support for the cc-usage hook-tier tests (feature 105). Not a test file itself.
//
// startFakeStore(): a local HTTP server standing in for Keycloak's token endpoint AND PostgREST's
// upsert semantics (merge-duplicates on the on_conflict key), recording every request. It is a
// unit-tier double; the real store contract is tested against real Postgres + PostgREST
// (infrastructure-as-code/docker/dev-usage/tests/store-contract.test.mjs).
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = resolve(HERE, '..', 'cc-usage.mjs');
export const FIXTURES = join(HERE, 'fixtures', 'cc-usage');
export const SESSION = {
  A: '11111111-1111-4111-8111-111111111111',
  B: '22222222-2222-4222-8222-222222222222',
  C: '33333333-3333-4333-8333-333333333333',
  D: '44444444-4444-4444-8444-444444444444',
};
export const PROJECT = { A: '-workspaces-mcm', B: '-home-coder-worktrees-feat-a', C: '-workspaces-mcm', D: '-workspaces-mcm' };

export async function startFakeStore({ failTables = [] } = {}) {
  const tables = new Map(); // table → Map(key → row)
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: u.pathname, query: u.search, rows: body && u.pathname !== '/token' ? JSON.parse(body) : null });
      if (u.pathname === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'tok-test', expires_in: 3600, token_type: 'Bearer' }));
        return;
      }
      const table = u.pathname.slice(1);
      if (failTables.includes(table)) {
        res.writeHead(503);
        res.end();
        return;
      }
      if (req.headers.authorization !== 'Bearer tok-test') {
        res.writeHead(401);
        res.end();
        return;
      }
      const keys = (u.searchParams.get('on_conflict') ?? '').split(',');
      const t = tables.get(table) ?? new Map();
      tables.set(table, t);
      for (const row of JSON.parse(body)) {
        const k = keys.map((c) => JSON.stringify(row[c])).join('|');
        t.set(k, { ...(t.get(k) ?? {}), ...row });
      }
      res.writeHead(201);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ingestUrl: base,
    tokenUrl: `${base}/token`,
    tables,
    requests,
    rows: (table) => [...(tables.get(table)?.values() ?? [])],
    close: () => new Promise((r) => server.close(r)),
  };
}

/** A temp CLAUDE_CONFIG_DIR holding a copy of the fixtures. */
export function tempConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-usage-cfg-'));
  cpSync(join(FIXTURES, 'projects'), join(dir, 'projects'), { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function envFor(configDir, store, extra = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...extra };
  for (const k of ['MCM_USAGE_INGEST_URL', 'MCM_USAGE_TOKEN_URL', 'MCM_USAGE_CLIENT_SECRET']) delete env[k];
  if (store) {
    env.MCM_USAGE_INGEST_URL = store.ingestUrl;
    env.MCM_USAGE_TOKEN_URL = store.tokenUrl;
    env.MCM_USAGE_CLIENT_SECRET = 'test-secret';
  }
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return env;
}

/** Run the CLI asynchronously (the fake store lives in this process's event loop). */
export function runCli(args, { env, stdin = '' } = {}) {
  return new Promise((resolveRun) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolveRun({ code, stdout, stderr, ms: performance.now() - t0 }));
    child.stdin.end(stdin);
  });
}

export function hookEvent(name, key, configDir, extra = {}) {
  return JSON.stringify({
    hook_event_name: name,
    session_id: SESSION[key],
    transcript_path: join(configDir, 'projects', PROJECT[key], `${SESSION[key]}.jsonl`),
    cwd: '/workspaces/mcm',
    ...extra,
  });
}
