// Feature 064 (item #337) — the assistant has exactly ONE send path.
//
// `useAssistantRun` (frontend/mcm-app/src/hooks/use-assistant.tsx) holds the queue that features 053
// and 054 added: it resolves the agent from the live registry when the React-state handle lags,
// queues when the agent is busy or momentarily absent, and flushes one message per completed run.
//
// THAT FIX WAS APPLIED TO TWO OF FIVE SEND PATHS, and nothing noticed for a year. Three components
// kept their own `useAgent` handle and returned early when the agent was busy:
//
//   request-import-file.tsx    dropped the import turn AFTER the upload had already succeeded
//   disambiguation-options.tsx dropped a `disambig-option-N` pick
//   render-movie-card.tsx      dropped a card action
//
// The cost of the first one, measured on CI run 2541: `agent-import-disambiguate` failed BOTH
// attempts waiting 150 s each for a `selection-options` element that could not appear, because no
// turn was ever sent to consume the staged file. It blocked a comment-only pull request (#339), and
// for three sessions the class was read as "the model chose not to disambiguate".
//
// A dropped turn is invisible by construction — no error, no echo, no request. So this is enforced
// statically rather than reviewed: a component that sends must do it through the hook.
//
// Static — it parses the sources rather than running them, so it runs in the tooling tier instead of
// needing a 35-minute app-e2e job to enforce a structural rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_DIR = resolve(REPO_ROOT, 'frontend/mcm-app/src');

/** The one file allowed to drive the agent directly — it IS the shared send path. */
export const SEND_PATH_FILE = 'hooks/use-assistant.tsx';

/** Directly starting a run. Everything else must go through `useAssistantRun().run()`. */
const RUN_AGENT = /\brunAgent\s*\(/;

/**
 * An assistant send guarded on the agent being busy.
 *
 * This is the shape that drops the turn: the component decides, in a synchronous callback, that
 * because a run is in flight there is nothing to do. The queue exists precisely so that decision is
 * never taken at a call site.
 */
const IS_RUNNING_GUARD = /\bisRunning\b[^\n]*\breturn\b|\breturn\b[^\n]*\bisRunning\b/;

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'unit-tests' || entry === '__tests__' || entry === 'test-support') continue;
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Files that drive the agent themselves instead of going through the shared hook.
 *
 * The detector reads the FILE, not a call graph: a component that mentions `runAgent` at all is
 * either the send path or a bypass of it, and there is no third case worth the complexity.
 */
export function bypassingSendPath(files) {
  const found = [];
  for (const { path, text } of files) {
    if (path === SEND_PATH_FILE) continue;
    text.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // a comment naming it is not a call
      if (RUN_AGENT.test(line)) found.push(`${path}:${i + 1} runAgent`);
      else if (IS_RUNNING_GUARD.test(line)) found.push(`${path}:${i + 1} isRunning guard`);
    });
  }
  return found;
}

function appSources() {
  return sourceFiles(SRC_DIR).map((full) => ({
    path: relative(SRC_DIR, full).split('\\').join('/'),
    text: readFileSync(full, 'utf8'),
  }));
}

test('only use-assistant.tsx drives the agent — every other send is queued', () => {
  const offenders = bypassingSendPath(appSources());
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} site(s) send to the assistant outside the shared queue. A send guarded on `
      + '`isRunning` DROPS the turn — silently, with no error and no request — which is how a member '
      + "loses a pick, and how an already-uploaded spreadsheet is stranded. Call "
      + `\`useAssistantRun().run(text)\` from \`@/hooks/${SEND_PATH_FILE}\` instead. `
      + 'See specs/064-agent-turn-delivery/ and item #337.\n  '
      + offenders.join('\n  '),
  );
});

test('the send path itself is still where the queue lives', () => {
  // If `useAssistantRun` were ever emptied out, the test above would pass trivially — every call
  // site would be routing through a hook that no longer queues. Pin the three properties the
  // queue is made of rather than trusting the file's name.
  const text = readFileSync(resolve(SRC_DIR, SEND_PATH_FILE), 'utf8');
  assert.match(text, /export function useAssistantRun/, 'the shared send path is gone');
  assert.match(text, /pendingRef/, 'the queue is gone — call sites now drop instead of queueing');
  assert.match(
    text,
    /\[agent, isRunning, resolveAgent, fire\]/,
    'the flush effect no longer depends on `isRunning`, so a run COMPLETING cannot flush the queue '
      + '— the exact defect feature 054 fixed (a queued message dropped permanently, silently)',
  );
});

// The detector is only worth having if it still fires. A guard that has quietly stopped matching
// reads exactly like a codebase with no violations — this repository's most expensive failure shape.
test('(#337-meta) it catches a direct runAgent call', () => {
  const sample = [{ path: 'components/agent/x.tsx', text: '  void copilotkit.runAgent({ agent });' }];
  assert.equal(bypassingSendPath(sample).length, 1, 'a direct runAgent call was not caught');
});

test('(#337-meta) it catches the isRunning early-return, in both orders', () => {
  const before = [{ path: 'components/agent/x.tsx', text: '  if (!agent || agent.isRunning) return;' }];
  const after = [{ path: 'components/agent/x.tsx', text: '  if (actioned || (agent.isRunning ?? false)) return;' }];
  assert.equal(bypassingSendPath(before).length, 1, 'the guard shape from request-import-file was missed');
  assert.equal(bypassingSendPath(after).length, 1, 'the guard shape from render-movie-card was missed');
});

test('(#337-meta) it spares the send path itself and plain comments', () => {
  assert.deepEqual(
    bypassingSendPath([
      { path: SEND_PATH_FILE, text: '  void copilotkit.runAgent({ agent: target });' },
      { path: 'components/agent/y.tsx', text: '  // returning on isRunning would drop the turn' },
    ]),
    [],
    'the hook must be allowed to send, and its own documentation must not fail the build',
  );
});

test('(#337-meta) it does NOT flag reading isRunning for display', () => {
  // `useAssistantRun` returns `isRunning` so the dock can show a busy state. Reading it is fine;
  // deciding not to send because of it is not.
  assert.deepEqual(
    bypassingSendPath([
      { path: 'components/agent/z.tsx', text: '  const { run, isRunning } = useAssistantRun();' },
      { path: 'components/agent/z.tsx', text: '  <Spinner visible={isRunning} />' },
    ]),
    [],
    'reading the flag is not a bypass — banning it would leave no way to render a busy state',
  );
});
