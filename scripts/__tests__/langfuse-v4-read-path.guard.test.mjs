// Feature 072 / item #433 — no source may read a Langfuse API that Langfuse 4 removed.
//
// WHAT THIS CATCHES, and why the job's green tick does not. Langfuse 4 removes `GET /api/public/traces`:
// the route returns **404**, it is not merely empty. Measured 2026-09-13 against the live 4.x stack, with
// the v4 replacement returning the same data:
//
//   GET /api/public/traces          -> 404   (route gone)
//   GET /api/public/v2/observations -> 200   (3 rows; total_cost, latency, session_id, is_root_observation)
//
// `agents/movie-assistant/tests/integration/test_observability_sc008.py` polled the dead route via
// `client.api.trace.list(session_id=…)` to assert per-turn cost and p95 latency. That is the dangerous
// shape: the SC-008 guarantee would not have failed loudly, it would have **stopped being checked** — and
// the test is credential-gated, so on a machine without a priced provider it SKIPS, which reads as green.
//
// The ingestion side is deliberately NOT policed here: the gateway ships langfuse SDK 4.15.1 and writes
// over OTLP (measured 200), so `POST /api/public/ingestion`'s `events_only` rejection does not touch it.
// Policing ingestion would invite someone to "fix" it with LANGFUSE_MIGRATION_V4_WRITE_MODE=dual, which
// restores only ingestion and would mask an unmigrated read path (spec FR-013).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Routes and SDK calls Langfuse 4 removed. `trace.get(` is NOT listed: single-trace fetch still exists.
const REMOVED = [
  { pattern: /\bapi\.trace\.list\s*\(/, what: 'client.api.trace.list(...)' },
  { pattern: /['"`][^'"`]*\/api\/public\/traces\b/, what: 'GET /api/public/traces' },
];

const SOURCES = () =>
  globSync('{agents,mcp-servers,backend,frontend,scripts,e2e}/**/*.{py,ts,tsx,mjs,js}', { cwd: REPO_ROOT })
    .filter((p) => !p.includes('node_modules') && !p.includes('/.venv/'))
    // this guard names the forbidden strings, so it must not match itself
    .filter((p) => !p.endsWith('langfuse-v4-read-path.guard.test.mjs'));

test('no source reads a Langfuse API that version 4 removed (item #433 / FR-012)', () => {
  const hits = [];
  for (const rel of SOURCES()) {
    const text = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
    for (const { pattern, what } of REMOVED) {
      if (pattern.test(text)) {
        const line = text.split('\n').findIndex((l) => pattern.test(l)) + 1;
        hits.push(`  ${rel}:${line}  uses ${what}`);
      }
    }
  }

  assert.deepEqual(
    hits,
    [],
    'Source reads a Langfuse API removed in v4 — the route 404s, so the read returns nothing and the\n' +
      'assertion built on it stops meaning anything:\n' +
      hits.join('\n') +
      '\n  Replace with `api.observations.get_many(session_id=…, is_root_observation=True)` and read\n' +
      '  `total_cost` / `latency` off each observation (measured 1:1 with the old trace fields).\n' +
      '  Do NOT reach for LANGFUSE_MIGRATION_V4_WRITE_MODE=dual: it restores INGESTION only, never this\n' +
      '  read path, so it would hide the problem rather than fix it (spec FR-013).',
  );
});

test('the SC-008 test still asserts cost and latency at all — the guard must not be satisfiable by deletion', () => {
  // Removing the assertions would also make the test above pass. The point of SC-008 is the evidence, so
  // the evidence is pinned independently of which API produces it.
  const rel = 'agents/movie-assistant/tests/integration/test_observability_sc008.py';
  const text = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
  assert.match(text, /cost_usd/, `${rel} no longer mentions cost_usd — SC-008 asserts per-turn COST`);
  assert.match(text, /latency_ms/, `${rel} no longer mentions latency_ms — SC-008 asserts p95 LATENCY`);
  assert.match(
    text,
    /observations\.get_many/,
    `${rel} does not use observations.get_many — the v4 read path (FR-012)`,
  );
});
