// Feature 105 US3 — activity labelling (data-model.md "Labelling"; FR-023, FR-024; US3-AC1, AC2). T042.
// A turn's signals are computed in the container from command text and paths, which never ship; only
// the label and the id of the rule that fired leave it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bashTags, labelActivity } from '../lib/cc-usage/label-activity.mjs';

const sig = (over = {}) => ({ skills: [], editAreas: [], bash: [], tools: [], ...over });
const bash = (...commands) => commands.map((c) => ({ family: c.split(' ')[0] === 'cd' ? c.split('&& ')[1].split(' ')[0] : c.split(' ')[0], tags: bashTags(c) }));

const CASES = [
  // [order, expected activity, expected rule, signals]
  [1, 'plan', 'speckit-skill', sig({ skills: ['speckit-plan'], tools: ['Read'] })],
  [1, 'specify', 'speckit-skill', sig({ skills: ['speckit-specify'] })],
  [1, 'clarify', 'speckit-skill', sig({ skills: ['speckit-clarify'] })],
  [1, 'tasks', 'speckit-skill', sig({ skills: ['speckit-tasks'] })],
  [1, 'analyze', 'speckit-skill', sig({ skills: ['speckit-analyze'] })],
  [2, 'implement', 'implement-skill', sig({ skills: ['speckit-implement'], tools: ['Edit'], editAreas: ['docs'] })],
  [2, 'implement', 'implement-edit', sig({ tools: ['Edit'], editAreas: ['frontend'] })],
  [2, 'implement', 'implement-edit', sig({ tools: ['Write'], editAreas: ['mcp-servers'] })],
  [3, 'test', 'test-tier', sig({ tools: ['Bash'], bash: bash('pnpm nx test mc-service') })],
  [3, 'test', 'test-tier', sig({ tools: ['Bash'], bash: bash('node --test scripts/__tests__/x.test.mjs') })],
  [3, 'test', 'test-tier', sig({ tools: ['Bash'], bash: bash('cargo test -p mc-service') })],
  [3, 'test', 'test-tier', sig({ tools: ['Bash'], bash: bash('npx playwright test') })],
  [4, 'ci-diagnosis', 'ci-diagnosis', sig({ tools: ['Bash'], bash: bash('node scripts/ci-status.mjs status --pr 1') })],
  [5, 'infra', 'infra-command', sig({ tools: ['Bash'], bash: bash('docker compose up -d') })],
  [5, 'infra', 'infra-edit', sig({ tools: ['Edit'], editAreas: ['infrastructure-as-code'] })],
  [5, 'infra', 'infra-edit', sig({ tools: ['Edit'], editAreas: ['.devcontainer'] })],
  [6, 'docs', 'docs-edit', sig({ tools: ['Edit'], editAreas: ['docs'] })],
  [6, 'docs', 'docs-skill', sig({ skills: ['wiki-refresh'], tools: ['Bash'], bash: bash('node scripts/wiki-refresh.mjs --stale') })],
  [7, 'backlog', 'backlog-command', sig({ tools: ['Bash'], bash: bash('node scripts/backlog.mjs list') })],
  [7, 'backlog', 'backlog-skill', sig({ skills: ['forgejo-issues'], tools: ['Read'] })],
  [8, 'git', 'git-only', sig({ tools: ['Bash', 'Bash'], bash: bash('git status', 'node scripts/forge-pr.mjs open --head x') })],
  [9, 'explore', 'read-only', sig({ tools: ['Read', 'Grep', 'Glob'] })],
  [10, 'conversation', 'no-tools', sig()],
  [99, 'unclassified', 'unclassified', sig({ tools: ['Bash'], bash: bash('ls -la') })],
];

for (const [order, activity, rule, s] of CASES) {
  test(`rule ${order}: ${activity} via ${rule}`, () => {
    assert.deepEqual(labelActivity(s), { activity, activity_rule: rule });
  });
}

test('a turn matching two rules gets the earlier one', () => {
  // implement (2) and test (3) and docs (6) all match: implement wins.
  const s = sig({ tools: ['Edit', 'Bash'], editAreas: ['backend', 'docs'], bash: bash('cargo test') });
  assert.deepEqual(labelActivity(s), { activity: 'implement', activity_rule: 'implement-edit' });
  // a speckit skill (1) beats an infra edit (5)
  assert.equal(labelActivity(sig({ skills: ['speckit-tasks'], editAreas: ['infrastructure-as-code'] })).activity, 'tasks');
});

test('git-only means ONLY git or the forge PR script: one other command breaks it', () => {
  assert.equal(labelActivity(sig({ tools: ['Bash', 'Bash'], bash: bash('git log', 'ls') })).activity, 'unclassified');
  assert.equal(labelActivity(sig({ tools: ['Bash', 'Read'], bash: bash('git log') })).activity, 'unclassified');
});

test('bashTags reads the command, skipping a cd prefix and env assignments', () => {
  assert.deepEqual(bashTags('cd /x && CI=true pnpm nx e2e mcm-app-e2e'), ['test']);
  assert.deepEqual(bashTags('pnpm nx build mcm-app'), []);
  assert.deepEqual(bashTags('node scripts/ci-failure-digest.mjs --run 9'), ['ci']);
  assert.deepEqual(bashTags('sbx ls'), ['infra']);
  assert.deepEqual(bashTags('git -C /w status'), ['git']);
});
