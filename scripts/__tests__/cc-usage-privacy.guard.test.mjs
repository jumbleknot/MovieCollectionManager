// Guard (feature 105; US1-AC6, FR-012, FR-003, SC-004): nothing but names, counts and sizes leaves
// the container. Every fixture's content fields hold SENTINEL-… strings; this parses every fixture,
// builds exactly the batches the shipper sends (shapeRecords — the one function ship-records.mjs
// applies to every batch), and asserts on the serialized result (contracts/store-http.md
// "Record shape constraints").
//
// Defence in depth: it ALSO feeds records carrying smuggled content fields (a parser regression
// that started emitting `command` or `text`) and asserts the allowlist drops them. That is the
// mutation this guard exists to catch: make privacy-shape.mjs a pass-through and it fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeSession } from '../lib/cc-usage/parse-transcript.mjs';
import { shapeRecords } from '../lib/cc-usage/privacy-shape.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cc-usage', 'projects');
const FORBIDDEN_KEY = /content|text|prompt|stdout|stderr|command|path|filepath|description|oldstring|newstring/i;
// Data-model columns whose NAMES merely contain a forbidden word; their values are numbers or a family.
const NAME_EXCEPTIONS = new Set(['context_tokens_at_start', 'command_family']);

function allSessions() {
  const out = [];
  for (const projectDir of readdirSync(FX)) {
    const dir = join(FX, projectDir);
    const ids = new Set(readdirSync(dir).map((n) => n.replace(/\.jsonl$/, '')));
    for (const sessionId of ids) {
      const subDir = join(dir, sessionId, 'subagents');
      const subagents = existsSync(subDir)
        ? readdirSync(subDir).filter((n) => n.endsWith('.meta.json')).map((f) => {
          const agentId = f.slice('agent-'.length, -'.meta.json'.length);
          const t = join(subDir, `agent-${agentId}.jsonl`);
          return { agentId, meta: JSON.parse(readFileSync(join(subDir, f), 'utf8')), transcript: existsSync(t) ? readFileSync(t) : null };
        })
        : [];
      const mainPath = join(dir, `${sessionId}.jsonl`);
      out.push(summarizeSession({ sessionId, projectDir, main: existsSync(mainPath) ? readFileSync(mainPath) : null, subagents }));
    }
  }
  return out;
}

function walk(value, visit, key = '') {
  if (Array.isArray(value)) value.forEach((v) => walk(v, visit, key));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { visit({ key: k }); walk(v, visit, k); }
  else visit({ key, value });
}

function assertShippable(batches) {
  const serialized = JSON.stringify(batches);
  const sentinel = serialized.match(/SENTINEL-[A-Za-z]+-\d+/);
  assert.equal(sentinel, null, `sentinel ${sentinel?.[0]} found in shipped batch`);
  const host = hostname();
  walk(batches, ({ key, value }) => {
    if (value === undefined) {
      assert.ok(NAME_EXCEPTIONS.has(key) || !FORBIDDEN_KEY.test(key), `forbidden key shipped: ${key}`);
      return;
    }
    if (typeof value !== 'string') return;
    assert.ok(value.length <= 200 || key === 'suggestion', `string over 200 chars in ${key}`);
    assert.ok(!value.startsWith('/'), `absolute path shipped in ${key}: ${value}`);
    assert.ok(!/\/(workspaces|home|tmp)\//.test(value), `host path shipped in ${key}: ${value}`);
    assert.ok(!/\.ts\.net\b/i.test(value), `tailnet host name shipped in ${key}`);
    assert.ok(host.length < 4 || !value.includes(host), `container host name shipped in ${key}`);
  });
}

test('every batch built from every fixture is free of content, paths and host names', () => {
  const sessions = allSessions();
  assert.equal(sessions.length, 4, 'all four fixture sessions parsed');
  for (const s of sessions) assertShippable(shapeRecords(s));
});

test('the allowlist drops smuggled content fields and over-long strings (mutation guard)', () => {
  const [s] = allSessions();
  const tampered = {
    ...s,
    session: { ...s.session, prompt: 'SENTINEL-prompt-99', cwd: '/workspaces/mcm' },
    modelCalls: s.modelCalls.map((c) => ({ ...c, text: 'SENTINEL-text-99' })),
    turns: s.turns.map((t) => ({ ...t, command: 'SENTINEL-command-99', areas: [...t.areas, 'x'.repeat(300)] })),
    toolUse: s.toolUse.map((t) => ({ ...t, filePath: '/home/coder/SENTINEL-path-99', stdout: 'SENTINEL-stdout-99' })),
    skillUse: s.skillUse.map((t) => ({ ...t, description: 'SENTINEL-description-99' })),
  };
  tampered.session.starting_branch = 'y'.repeat(500);
  assertShippable(shapeRecords(tampered));
});

test('the allowlisted columns survive shaping', () => {
  const s = allSessions().find((x) => x.session.session_id.startsWith('1111'));
  const b = shapeRecords(s);
  assert.equal(b.sessions.length, 1);
  assert.equal(b.model_calls.length, s.modelCalls.length);
  assert.deepEqual(Object.keys(b.model_calls[0]).sort(), [
    'agent_id', 'cache_read_tokens', 'cache_write_1h_tokens', 'cache_write_5m_tokens', 'input_tokens',
    'message_id', 'model', 'output_tokens', 'request_id', 'session_id', 'skill', 'thinking_tokens', 'ts', 'turn_seq',
  ]);
  assert.deepEqual(b.turns.map((t) => t.areas), [['docs'], ['scripts'], []]);
});
