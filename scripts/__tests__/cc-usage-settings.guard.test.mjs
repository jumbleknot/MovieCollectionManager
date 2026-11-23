// Guard (feature 105; US1-AC1, FR-001): the committed .claude/settings.json carries exactly the three
// capture hooks of contracts/hooks-and-skill.md (key spellings confirmed by T001, research "Spike
// results" (b)), and the plugin keys are exactly the intended set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
const COMMAND = 'node "$CLAUDE_PROJECT_DIR/scripts/cc-usage.mjs" hook';

test('exactly three hook events, each one command hook running cc-usage.mjs hook', () => {
  assert.ok(settings.hooks?.SessionStart, 'missing hooks.SessionStart');
  assert.deepEqual(Object.keys(settings.hooks).sort(), ['SessionEnd', 'SessionStart', 'Stop']);
  assert.deepEqual(settings.hooks.SessionStart, [{ hooks: [{ type: 'command', async: true, command: COMMAND }] }]);
  assert.deepEqual(settings.hooks.Stop, [{ hooks: [{ type: 'command', async: true, command: COMMAND }] }]);
  assert.deepEqual(settings.hooks.SessionEnd, [{ hooks: [{ type: 'command', timeout: 10, command: COMMAND }] }]);
});

test('no statusline is committed (the usage statusline is opt-in, research R14)', () => {
  assert.equal(settings.statusLine, undefined);
});

test('the plugin keys are exactly the intended set', () => {
  // Snapshot of origin/main's values when feature 105 added the hooks block (2026-11-21), minus the
  // Nx plugin, removed 2026-11-22: an unpinned third-party marketplace with zero calls across 73
  // measured sessions (host + dev container). A plugin added or removed here must update this list
  // in the same change, so no marketplace slips into every contributor's session unreviewed.
  assert.deepEqual(settings.extraKnownMarketplaces, {
    'callstack-agent-skills': {
      source: { source: 'github', repo: 'callstackincubator/agent-skills', ref: '59e9d17446a248b21d86f078fcd0bd2d36db1ca4' },
    },
  });
  assert.deepEqual(settings.enabledPlugins, {
    'building-react-native-apps@callstack-agent-skills': true,
  });
  assert.deepEqual(Object.keys(settings).sort(), ['enabledPlugins', 'extraKnownMarketplaces', 'hooks']);
});

test('every marketplace is pinned to a full commit SHA', () => {
  // An unpinned github marketplace runs whatever its repository holds at install/update time in every
  // contributor's session; a branch or tag can be moved. Only a full 40-hex SHA in `ref` freezes it
  // (Claude Code v2.1.324+; the github source has no separate `sha` field). Bump the SHA deliberately,
  // after reading the upstream diff.
  for (const [name, { source }] of Object.entries(settings.extraKnownMarketplaces ?? {})) {
    assert.match(source.ref ?? '', /^[0-9a-f]{40}$/, `marketplace ${name} is not pinned to a full commit SHA`);
  }
});
