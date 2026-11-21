// Feature 105 — the pure transcript parser (US1-AC1, US1-AC2; FR-002–FR-005).
// Runs over the synthetic fixtures in fixtures/cc-usage (see its README for what each exercises).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  commandFamily,
  initialState,
  parseTranscript,
  summarizeSession,
} from '../lib/cc-usage/parse-transcript.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cc-usage', 'projects');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const D = '44444444-4444-4444-8444-444444444444';

/** Read a session the way the CLI will: main transcript + every subagent meta/transcript pair. */
function loadSession(projectDir, sessionId) {
  const mainPath = join(FX, projectDir, `${sessionId}.jsonl`);
  const subDir = join(FX, projectDir, sessionId, 'subagents');
  const subagents = [];
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir).filter((n) => n.endsWith('.meta.json')).sort()) {
      const agentId = f.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
      const tPath = join(subDir, `agent-${agentId}.jsonl`);
      subagents.push({
        agentId,
        meta: JSON.parse(readFileSync(join(subDir, f), 'utf8')),
        transcript: existsSync(tPath) ? readFileSync(tPath) : null,
      });
    }
  }
  return summarizeSession({
    sessionId,
    projectDir,
    main: existsSync(mainPath) ? readFileSync(mainPath) : null,
    subagents,
  });
}

const sessA = () => loadSession('-workspaces-mcm', A);
const sessB = () => loadSession('-home-coder-worktrees-feat-a', B);

test('one model call per message.id: streamed duplicates collapse (research R2)', () => {
  const { modelCalls } = sessA();
  const main = modelCalls.filter((c) => c.agent_id === null).map((c) => c.message_id);
  assert.deepEqual(main, ['msg_A1', 'msg_A2', 'msg_A3', 'msg_A4', 'msg_A5', 'msg_A6']);
  assert.equal(new Set(modelCalls.map((c) => c.message_id)).size, modelCalls.length);
});

test('four token types, and the 5m/1h cache-write split sums to cache_creation', () => {
  const a1 = sessA().modelCalls.find((c) => c.message_id === 'msg_A1');
  assert.deepEqual(
    {
      input: a1.input_tokens, output: a1.output_tokens, read: a1.cache_read_tokens,
      w5: a1.cache_write_5m_tokens, w1: a1.cache_write_1h_tokens, thinking: a1.thinking_tokens,
    },
    { input: 10, output: 50, read: 0, w5: 400, w1: 600, thinking: 30 },
  );
  assert.equal(a1.request_id, 'req_A1');
  assert.equal(a1.turn_seq, 1);
});

test('turn boundaries on human prompts; a task-notification wake-up is its own flagged turn', () => {
  const { turns } = sessA();
  assert.deepEqual(turns.map((t) => [t.turn_seq, t.origin]), [[1, 'human'], [2, 'human'], [3, 'task_notification']]);
  assert.equal(turns[0].context_tokens_at_start, 10 + 0 + 1000);
  assert.equal(turns[1].idle_gap_s, 30 * 60 + 60 - 35); // 09:00:35 → 09:31:00
});

test('compactions are counted', () => {
  assert.equal(sessA().session.compactions, 1);
});

test('attributionSkill → skill use and the call\'s skill', () => {
  const s = sessA();
  assert.deepEqual(s.skillUse, [{ session_id: A, skill: 'speckit-plan', invocations: 1, first_turn: 2 }]);
  assert.equal(s.modelCalls.find((c) => c.message_id === 'msg_A4').skill, 'speckit-plan');
  assert.equal(s.modelCalls.find((c) => c.message_id === 'msg_A1').skill, null);
});

test('tool use aggregates per turn; command_family is the first real word only', () => {
  const rows = sessA().toolUse.map((r) => [r.turn_seq, r.tool, r.command_family, r.calls, r.rtk_calls]);
  assert.deepEqual(rows.sort(), [
    [1, 'Bash', 'curl', 1, 0],
    [1, 'Bash', 'git', 2, 1],
    [1, 'Bash', 'pnpm', 1, 0],
    [1, 'Edit', '', 1, 0],
    [2, 'Agent', '', 1, 0],
    [2, 'Read', '', 4, 0],
  ].sort());
  const agent = sessA().toolUse.find((r) => r.tool === 'Agent');
  assert.equal(agent.subagent_type, 'Explore');
  assert.equal(agent.result_bytes, 4096, 'persistedOutputSize is the size of a lone result');
  const pnpm = sessA().toolUse.find((r) => r.command_family === 'pnpm');
  assert.equal(pnpm.result_bytes, Buffer.byteLength('SENTINEL-tool-output-1'));
});

test('commandFamily skips assignments and rtk, and never returns an unsafe word', () => {
  assert.equal(commandFamily('pnpm nx test x'), 'pnpm');
  assert.equal(commandFamily('API=http://host:3000 TOKEN=$(cat f) curl -s x'), 'curl');
  assert.equal(commandFamily('rtk git status'), 'git');
  assert.equal(commandFamily('/usr/bin/node scripts/x.mjs'), 'node');
  assert.equal(commandFamily('cd /home/coder/worktrees/a && git status'), 'git');
  assert.equal(commandFamily('$(echo SENTINEL-x) y'), 'other');
  assert.equal(commandFamily('"quoted thing" y'), 'other');
  assert.equal(commandFamily(''), 'other');
});

test('a subagent transcript is attributed to the parent turn through meta.toolUseId', () => {
  const sub = sessA().modelCalls.filter((c) => c.agent_id !== null);
  assert.deepEqual(sub.map((c) => [c.message_id, c.agent_id, c.turn_seq]), [['msg_X1', 'x', 2], ['msg_X2', 'x', 2]]);
});

test('gaps are partial with a reason — never complete, never zero (US1-AC2)', () => {
  const a = sessA().session;
  assert.equal(a.capture_status, 'partial');
  assert.deepEqual([...a.partial_reasons].sort(), ['format-drift', 'subagent-transcript-missing']);
  const b = sessB().session;
  assert.equal(b.capture_status, 'partial');
  assert.deepEqual(b.partial_reasons, ['format-drift']);
  assert.equal(sessB().modelCalls.length, 2, 'the usage-less line is not a zero-token call');
});

test('a session known only from a subagent meta file is not_captured, with no token totals', () => {
  const d = loadSession('-workspaces-mcm', D);
  assert.equal(d.session.capture_status, 'not_captured');
  assert.deepEqual(d.modelCalls, []);
  assert.deepEqual(d.turns, []);
  for (const k of Object.keys(d.session)) assert.ok(!/tokens/.test(k), `no token field on a not_captured session: ${k}`);
});

test('session fields carry no host path', () => {
  const { session } = sessA();
  assert.equal(session.session_id, A);
  assert.equal(session.project_dir, '-workspaces-mcm');
  assert.equal(session.starting_worktree, 'mcm');
  assert.equal(session.starting_branch, 'main');
  assert.equal(session.entrypoint, 'claude-vscode');
  assert.equal(session.cc_version, '2.1.327');
  assert.equal(session.started_at, '2026-11-10T09:00:01.000Z'); // the queue-operation line before it is ignorable
  assert.equal(sessB().session.starting_worktree, 'feat-a');
});

test('each turn carries its top-level areas and a re-read count; no path is emitted', () => {
  const s = sessA();
  assert.deepEqual(s.turns.map((t) => t.areas), [['docs'], ['scripts'], []]);
  assert.deepEqual(s.turns.map((t) => t.rereads), [0, 1, 0]);
  assert.deepEqual(sessB().turns.map((t) => t.areas), [['frontend']]);
  const out = JSON.stringify(s);
  assert.ok(!out.includes('SENTINEL-path'), 'a path leaked into parser output');
  assert.ok(!out.includes('/workspaces/'), 'an absolute path leaked into parser output');
});

test('parsing from a byte offset returns only the new records, and never a half-written line', () => {
  const buf = readFileSync(join(FX, '-workspaces-mcm', `${A}.jsonl`));
  const opts = { sessionId: A, projectDir: '-workspaces-mcm' };
  const whole = parseTranscript(buf, initialState(), opts);

  // Cut mid-way through a line: the partial line must not be consumed.
  const cut = buf.indexOf('msg_A3') + 3;
  const first = parseTranscript(buf.subarray(0, cut), initialState(), opts);
  assert.ok(first.state.offset < cut, 'offset stops at the last complete line');
  assert.equal(buf[first.state.offset - 1], 0x0a);
  const second = parseTranscript(buf, first.state, opts);

  const ids = (r) => r.records.modelCalls.map((c) => c.message_id);
  assert.deepEqual(ids(first), ['msg_A1', 'msg_A2']);
  assert.deepEqual(ids(second), ['msg_A3', 'msg_A4', 'msg_A5', 'msg_A6']);
  assert.equal(second.state.offset, whole.state.offset);
  assert.equal(second.state.offset, buf.length);
  // The turn that spans the cut is re-emitted whole (upsert), with the same values as one pass.
  const t1 = (r) => r.records.turns.find((t) => t.turn_seq === 1);
  assert.deepEqual(t1(second), t1(whole));
  const rerun = parseTranscript(buf, second.state, opts);
  assert.deepEqual(rerun.records.modelCalls, [], 'nothing new after the end');
});
