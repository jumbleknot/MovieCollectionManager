#!/usr/bin/env node
// Regenerates the synthetic Claude Code transcripts in this folder (feature 105, research R9).
//
//   node scripts/__tests__/fixtures/cc-usage/generate-fixtures.mjs
//
// Every line is hand-shaped to the fields research R1-R3 measured; nothing here was copied from a
// real transcript. Every content-bearing field holds a `SENTINEL-<field>-<n>` string so the privacy
// guard can prove none of it is ever shipped. After changing this file, re-run it AND
// `pnpm nx cc-usage-oracle infrastructure-as-code`, and review both diffs.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const P = join(ROOT, 'projects');

export const SESSION_A = '11111111-1111-4111-8111-111111111111'; // main checkout, rich
export const SESSION_B = '22222222-2222-4222-8222-222222222222'; // worktree feat-a, format drift
export const SESSION_C = '33333333-3333-4333-8333-333333333333'; // main checkout driving two worktrees
export const SESSION_D = '44444444-4444-4444-8444-444444444444'; // subagent meta only, no transcript

const VERSION = '2.1.327';
let uuidN = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidN).padStart(12, '0')}`;

function base(session, cwd, branch, ts, extra = {}) {
  return {
    parentUuid: null, isSidechain: false, uuid: uuid(), timestamp: ts, userType: 'external',
    entrypoint: 'claude-vscode', cwd, sessionId: session, version: VERSION, gitBranch: branch, ...extra,
  };
}

function usage(inp, out, c5m, c1h, cr, thinking = 0) {
  return {
    input_tokens: inp, output_tokens: out, cache_creation_input_tokens: c5m + c1h,
    cache_read_input_tokens: cr, output_tokens_details: { thinking_tokens: thinking },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: 'standard',
    cache_creation: { ephemeral_5m_input_tokens: c5m, ephemeral_1h_input_tokens: c1h }, speed: 'standard',
  };
}

function assistant(ctx, ts, msgId, reqId, content, u, extra = {}) {
  return {
    ...base(ctx.session, ctx.cwd, ctx.branch, ts, extra),
    type: 'assistant', requestId: reqId,
    message: { model: 'claude-opus-5-5', id: msgId, type: 'message', role: 'assistant', content, stop_reason: 'end_turn', usage: u },
  };
}

const human = (ctx, ts, n) => ({
  ...base(ctx.session, ctx.cwd, ctx.branch, ts), type: 'user', promptId: `prompt-${n}`,
  origin: { kind: 'human' }, permissionMode: 'default',
  message: { role: 'user', content: `SENTINEL-prompt-${n}` },
});

const wake = (ctx, ts, n) => ({
  ...base(ctx.session, ctx.cwd, ctx.branch, ts), type: 'user', promptId: `prompt-${n}`,
  origin: { kind: 'task-notification' }, message: { role: 'user', content: `SENTINEL-notification-${n}` },
});

const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });

function toolResults(ctx, ts, results, extra = {}) {
  return {
    ...base(ctx.session, ctx.cwd, ctx.branch, ts, extra), type: 'user',
    message: { role: 'user', content: results.map(([id, content]) => ({ tool_use_id: id, type: 'tool_result', content, is_error: false })) },
  };
}

const jsonl = (lines) => lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';

function write(rel, text) {
  const f = join(ROOT, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
}

export function generate() {
  rmSync(P, { recursive: true, force: true });
  uuidN = 0;

  // ---- Session A: main checkout, two human turns + one wake-up, duplicates, compaction, skill, subagents.
  const A = { session: SESSION_A, cwd: '/workspaces/mcm', branch: 'main' };
  const a = [
    { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-10T09:00:00.000Z', sessionId: SESSION_A, content: 'SENTINEL-queue-1' },
    human(A, '2026-11-10T09:00:01.000Z', 1),
    // Streamed response: one line per content block, identical usage (research R2).
    assistant(A, '2026-11-10T09:00:05.000Z', 'msg_A1', 'req_A1',
      [{ type: 'thinking', thinking: 'SENTINEL-thinking-1', signature: 'SENTINEL-signature-1' }], usage(10, 50, 400, 600, 0, 30)),
    assistant(A, '2026-11-10T09:00:06.000Z', 'msg_A1', 'req_A1',
      [toolUse('toolu_A1', 'Bash', { command: 'pnpm nx test SENTINEL-command-1', description: 'SENTINEL-description-1' })], usage(10, 50, 400, 600, 0, 30)),
    toolResults(A, '2026-11-10T09:00:20.000Z', [['toolu_A1', 'SENTINEL-tool-output-1']],
      { toolUseResult: { stdout: 'SENTINEL-stdout-1', stderr: 'SENTINEL-stderr-1', interrupted: false } }),
    assistant(A, '2026-11-10T09:00:25.000Z', 'msg_A2', 'req_A2', [
      toolUse('toolu_A2a', 'Bash', { command: 'git status SENTINEL-command-2', description: 'SENTINEL-description-2' }),
      // A leading assignment can hold a URL or a host name: the family must be the real command.
      toolUse('toolu_A2b', 'Bash', { command: 'API=http://SENTINEL-host-1:3000 curl -s "$API" SENTINEL-command-3' }),
      toolUse('toolu_A2c', 'Edit', { file_path: '/workspaces/mcm/docs/SENTINEL-path-1.md', old_string: 'SENTINEL-oldString-1', new_string: 'SENTINEL-newString-1' }),
      toolUse('toolu_A2d', 'Bash', { command: 'rtk git log SENTINEL-command-4' }),
    ], usage(5, 80, 200, 0, 1000)),
    toolResults(A, '2026-11-10T09:00:30.000Z', [
      ['toolu_A2a', 'SENTINEL-tool-output-2'], ['toolu_A2b', 'SENTINEL-tool-output-3'],
      ['toolu_A2c', 'SENTINEL-tool-output-4'], ['toolu_A2d', 'SENTINEL-tool-output-5'],
    ]),
    assistant(A, '2026-11-10T09:00:35.000Z', 'msg_A3', 'req_A3', [{ type: 'text', text: 'SENTINEL-text-1' }], usage(3, 20, 0, 0, 1200)),
    { ...base(SESSION_A, A.cwd, A.branch, '2026-11-10T09:30:00.000Z'), type: 'system', subtype: 'compact_boundary', content: 'SENTINEL-compact-1', level: 'info',
      compactMetadata: { trigger: 'auto', preTokens: 150000, postTokens: 20000, durationMs: 9000 } },
    human(A, '2026-11-10T09:31:00.000Z', 2),
    assistant(A, '2026-11-10T09:31:05.000Z', 'msg_A4', 'req_A4', [
      toolUse('toolu_A4r1', 'Read', { file_path: '/workspaces/mcm/scripts/SENTINEL-path-2.mjs' }),
      toolUse('toolu_A4r2', 'Read', { file_path: '/workspaces/mcm/scripts/SENTINEL-path-2.mjs' }),
      toolUse('toolu_A4r3', 'Read', { file_path: '/workspaces/mcm/scripts/SENTINEL-path-2.mjs' }),
      toolUse('toolu_A4r4', 'Read', { file_path: '/workspaces/mcm/scripts/SENTINEL-path-2.mjs' }),
      toolUse('toolu_A4', 'Agent', { description: 'SENTINEL-description-3', prompt: 'SENTINEL-prompt-3', subagent_type: 'Explore' }),
    ], usage(7, 120, 0, 300, 20000), { attributionSkill: 'speckit-plan' }),
    toolResults(A, '2026-11-10T09:32:00.000Z', [
      ['toolu_A4r1', 'SENTINEL-tool-output-6'], ['toolu_A4r2', 'SENTINEL-tool-output-7'],
      ['toolu_A4r3', 'SENTINEL-tool-output-8'], ['toolu_A4r4', 'SENTINEL-tool-output-9'],
      ['toolu_A4', 'SENTINEL-tool-output-10'],
    ], { toolUseResult: { agentId: 'x', agentType: 'Explore', persistedOutputSize: 4096, interrupted: false } }),
    assistant(A, '2026-11-10T09:32:10.000Z', 'msg_A5', 'req_A5', [{ type: 'text', text: 'SENTINEL-text-2' }], usage(2, 40, 0, 0, 20300), { attributionSkill: 'speckit-plan' }),
    wake(A, '2026-11-10T09:40:00.000Z', 4),
    assistant(A, '2026-11-10T09:40:05.000Z', 'msg_A6', 'req_A6', [{ type: 'text', text: 'SENTINEL-text-3' }], usage(4, 10, 100, 0, 20340)),
    '{"type":"assistant","message":{"id":"msg_BROKEN", SENTINEL-malformed-1',
  ];
  write(`projects/-workspaces-mcm/${SESSION_A}.jsonl`, jsonl(a));

  const X = { session: SESSION_A, cwd: '/workspaces/mcm', branch: 'main' };
  const sub = { isSidechain: true, agentId: 'x' };
  write(`projects/-workspaces-mcm/${SESSION_A}/subagents/agent-x.jsonl`, jsonl([
    { ...base(SESSION_A, X.cwd, X.branch, '2026-11-10T09:31:10.000Z', sub), type: 'user', message: { role: 'user', content: 'SENTINEL-prompt-5' } },
    assistant(X, '2026-11-10T09:31:15.000Z', 'msg_X1', 'req_X1', [toolUse('toolu_X1', 'Grep', { pattern: 'SENTINEL-pattern-1', path: '/workspaces/mcm/openwiki' })], usage(20, 30, 500, 0, 0), sub),
    toolResults(X, '2026-11-10T09:31:20.000Z', [['toolu_X1', 'SENTINEL-tool-output-11']], sub),
    assistant(X, '2026-11-10T09:31:25.000Z', 'msg_X2', 'req_X2', [{ type: 'text', text: 'SENTINEL-text-4' }], usage(1, 60, 0, 0, 520), sub),
  ]));
  const meta = (toolUseId, n) => JSON.stringify({ agentType: 'Explore', isBuiltIn: true, launchedWithDefaults: true, description: `SENTINEL-description-${n}`, toolUseId, spawnDepth: 1, requestShape: 'default', requestNonInteractive: false, finished: true }, null, 2) + '\n';
  write(`projects/-workspaces-mcm/${SESSION_A}/subagents/agent-x.meta.json`, meta('toolu_A4', 4));
  // A subagent that left no transcript (research R3: 27 meta files, 19 transcripts).
  write(`projects/-workspaces-mcm/${SESSION_A}/subagents/agent-y.meta.json`, meta('toolu_A4', 5));

  // ---- Session D: known only from a subagent meta file; no main transcript → not_captured.
  write(`projects/-workspaces-mcm/${SESSION_D}/subagents/agent-z.meta.json`, meta('toolu_D1', 6));

  // ---- Session B: worktree session on feat-a; one assistant line without usage (format drift).
  const B = { session: SESSION_B, cwd: '/home/coder/worktrees/feat-a', branch: 'feat-a' };
  write(`projects/-home-coder-worktrees-feat-a/${SESSION_B}.jsonl`, jsonl([
    human(B, '2026-11-12T14:00:00.000Z', 6),
    assistant(B, '2026-11-12T14:00:04.000Z', 'msg_B1', 'req_B1', [
      toolUse('toolu_B1', 'Edit', { file_path: '/home/coder/worktrees/feat-a/frontend/SENTINEL-path-3.tsx', old_string: 'SENTINEL-oldString-2', new_string: 'SENTINEL-newString-2' }),
    ], usage(6, 90, 3000, 0, 0)),
    toolResults(B, '2026-11-12T14:00:06.000Z', [['toolu_B1', 'SENTINEL-tool-output-12']]),
    { ...assistant(B, '2026-11-12T14:00:08.000Z', 'msg_B2', 'req_B2', [{ type: 'text', text: 'SENTINEL-text-5' }], undefined) },
    { type: 'ai-title', sessionId: SESSION_B, title: 'SENTINEL-title-1' },
    assistant(B, '2026-11-12T14:00:10.000Z', 'msg_B3', 'req_B3', [{ type: 'text', text: 'SENTINEL-text-6' }], usage(2, 15, 0, 0, 3000)),
  ]));

  // ---- Session C: main checkout driving worktrees feat-a then docs-b (attribution, US3).
  const C = { session: SESSION_C, cwd: '/workspaces/mcm', branch: 'main' };
  write(`projects/-workspaces-mcm/${SESSION_C}.jsonl`, jsonl([
    human(C, '2026-11-14T10:00:00.000Z', 7),
    assistant(C, '2026-11-14T10:00:05.000Z', 'msg_C1', 'req_C1', [
      toolUse('toolu_C1', 'Edit', { file_path: '/home/coder/worktrees/feat-a/frontend/SENTINEL-path-4.ts', old_string: 'SENTINEL-oldString-3', new_string: 'SENTINEL-newString-3' }),
    ], usage(8, 70, 2000, 0, 0)),
    toolResults(C, '2026-11-14T10:00:07.000Z', [['toolu_C1', 'SENTINEL-tool-output-13']]),
    human(C, '2026-11-14T10:10:00.000Z', 8),
    assistant(C, '2026-11-14T10:10:05.000Z', 'msg_C2', 'req_C2', [
      toolUse('toolu_C2a', 'Bash', { command: 'git -C /home/coder/worktrees/docs-b status SENTINEL-command-5' }),
      toolUse('toolu_C2b', 'Edit', { file_path: '/home/coder/worktrees/docs-b/docs/SENTINEL-path-5.md', old_string: 'SENTINEL-oldString-4', new_string: 'SENTINEL-newString-4' }),
    ], usage(4, 60, 500, 0, 2000)),
    toolResults(C, '2026-11-14T10:10:08.000Z', [['toolu_C2a', 'SENTINEL-tool-output-14'], ['toolu_C2b', 'SENTINEL-tool-output-15']]),
    human(C, '2026-11-14T10:20:00.000Z', 9),
    // Path-less call mid-feature: inherits docs-b, never "no feature" (research R17).
    assistant(C, '2026-11-14T10:20:05.000Z', 'msg_C3', 'req_C3', [
      toolUse('toolu_C3', 'Bash', { command: 'node scripts/forge-pr.mjs open SENTINEL-command-6' }),
    ], usage(3, 40, 0, 0, 2500)),
    toolResults(C, '2026-11-14T10:20:09.000Z', [['toolu_C3', 'SENTINEL-tool-output-16']]),
    human(C, '2026-11-14T10:30:00.000Z', 10),
    assistant(C, '2026-11-14T10:30:05.000Z', 'msg_C4', 'req_C4', [{ type: 'text', text: 'SENTINEL-text-7' }], usage(2, 25, 0, 0, 2600)),
    human(C, '2026-11-14T10:40:00.000Z', 11),
    // Two worktrees in one turn: majority (feat-a, 2 calls) wins over docs-b (1 call).
    assistant(C, '2026-11-14T10:40:05.000Z', 'msg_C5', 'req_C5', [
      toolUse('toolu_C5a', 'Read', { file_path: '/home/coder/worktrees/feat-a/frontend/SENTINEL-path-6.ts' }),
      toolUse('toolu_C5b', 'Read', { file_path: '/home/coder/worktrees/feat-a/frontend/SENTINEL-path-7.ts' }),
      toolUse('toolu_C5c', 'Read', { file_path: '/home/coder/worktrees/docs-b/docs/SENTINEL-path-8.md' }),
    ], usage(3, 30, 0, 0, 2700)),
    toolResults(C, '2026-11-14T10:40:07.000Z', [['toolu_C5a', 'SENTINEL-tool-output-17'], ['toolu_C5b', 'SENTINEL-tool-output-18'], ['toolu_C5c', 'SENTINEL-tool-output-19']]),
  ]));

  // ---- The fake worktrees attribution resolves against (US3).
  write('worktrees.json', JSON.stringify({
    '$comment': 'Fake worktree → branch and .specify/feature.json map for the attribution tests (feature 105, US3).',
    worktrees: {
      '/workspaces/mcm': { branch: 'main', featureJson: null },
      '/home/coder/worktrees/feat-a': { branch: 'feat-a', featureJson: null },
      '/home/coder/worktrees/docs-b': { branch: 'docs-b', featureJson: { feature_directory: 'specs/107-docs-b' } },
    },
  }, null, 2) + '\n');
}

generate();
