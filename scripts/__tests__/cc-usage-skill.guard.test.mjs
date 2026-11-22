// Guard (feature 105 US2, T037): the `usage` skill (contracts/hooks-and-skill.md). It must always pass
// the session it runs in (FR-019 — never "the newest transcript"), run `sync` only on request, stay
// small (it loads only on invocation, FR-022), and name only commands the CLI has.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USAGE } from '../cc-usage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = readFileSync(resolve(ROOT, '.claude', 'skills', 'usage', 'SKILL.md'), 'utf8');
const front = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
const commandLines = text.split('\n').filter((l) => /node scripts\/cc-usage\.mjs \S/.test(l));

test('frontmatter: name usage and a description', () => {
  assert.match(front, /^name: usage$/m);
  assert.match(front, /^description: \S.{20,}$/m);
});

test('at most 60 lines', () => {
  assert.ok(text.split('\n').length <= 60, `${text.split('\n').length} lines`);
});

test('every command that takes --session passes ${CLAUDE_SESSION_ID}', () => {
  const needs = ['now', 'sync', 'tag'];
  for (const l of commandLines) {
    const cmd = l.match(/cc-usage\.mjs (\S+)/)[1];
    if (needs.includes(cmd)) assert.match(l, /--session \$\{CLAUDE_SESSION_ID\}/, l);
  }
  assert.ok(commandLines.some((l) => / now --session /.test(l)), 'the skill shows `now`');
});

test('sync runs only when the user asks', () => {
  assert.match(text, /\bsync\b[^\n]*only (when|if) the user asks/i);
});

test('every command the skill names exists in the CLI', () => {
  for (const l of commandLines) {
    const cmd = l.match(/cc-usage\.mjs (\S+)/)[1];
    assert.match(USAGE, new RegExp(`^  ${cmd}\\b`, 'm'), `${cmd} is not a cc-usage command`);
  }
});
