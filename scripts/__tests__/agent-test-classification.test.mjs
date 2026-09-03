// Feature 056 (item #170) — every agent test must declare which tier it belongs to.
//
// `app-e2e` is a required merge gate, and 41 of its tests assert on a live LLM and live TMDB.
// MEASURED on two runs of IDENTICAL code (sha 1fada7a): #1684 reported
// `failed=0 flaky=0 passed=177`, #1685 reported `failed=1 flaky=7 passed=166`. Every alternative
// explanation was excluded by a measured counter — `verdict=healthy` (not the #173 collapse),
// `refresh_429=0`/`session_evicted=0` (not contention), 8 worker identities (not the shared user of
// #169), #179's livelock fixed. All eight affected entries were model-decision assertions.
//
// So the suite is split: assertions whose verdict is determined by code we control BLOCK a merge;
// assertions that depend on what the model chose do not. The rule lives in
// `openwiki/invariants/testing-tiers.md`.
//
// THIS GUARD EXISTS BECAUSE THE DEFAULT MUST NOT BE SILENT. An agent test carrying neither tag would
// otherwise drift into whichever selection happened to match it, and the reader of a green gate could
// not tell which tier had actually run it. An unclassified test is a failure, not a default (FR-003).
//
// Static — it parses the spec files rather than running them, so it runs in the tooling tier instead
// of needing a 30-minute CI job to enforce a naming rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const E2E_DIR = resolve(REPO_ROOT, 'frontend/mcm-app/tests/e2e/web');

/** The two tiers. Exactly one must be present on every agent test. */
export const GATE_TAG = '@gate';
export const MODEL_TAG = '@model-decision';

const AGENT_SPEC = /^(agent|assistant)-.*\.spec\.ts$/;

function agentSpecFiles() {
  return readdirSync(E2E_DIR).filter((f) => AGENT_SPEC.test(f)).sort();
}

/**
 * Every `test(...)` declaration in a spec, with the text of its declaration line(s).
 *
 * Deliberately crude: a real parser would be better and is not worth it here, because the shape this
 * has to catch is a missing TAG, and a tag is a literal string on or just after the title. The guard
 * fails closed — an unparseable declaration counts as unclassified rather than being skipped.
 */
function testDeclarations(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    if (!/^\s*test\s*\(/.test(line)) return;
    // A declaration may wrap: take this line plus the next two, which covers
    // `test('title', { tag: '@x' }, async ({ page }) => {` in every style used here.
    out.push({ line: i + 1, text: lines.slice(i, i + 3).join('\n') });
  });
  return out;
}

const classify = (decl) => ({
  gate: decl.text.includes(GATE_TAG),
  model: decl.text.includes(MODEL_TAG),
});

test('every agent/dock test declares exactly one tier', () => {
  const unclassified = [];
  const both = [];

  for (const file of agentSpecFiles()) {
    const text = readFileSync(join(E2E_DIR, file), 'utf8');
    for (const decl of testDeclarations(text)) {
      const { gate, model } = classify(decl);
      if (gate && model) both.push(`${file}:${decl.line}`);
      else if (!gate && !model) unclassified.push(`${file}:${decl.line}`);
    }
  }

  assert.deepEqual(
    both,
    [],
    `a test cannot be in both tiers — it would run twice and be counted twice:\n  ${both.join('\n  ')}`,
  );
  assert.deepEqual(
    unclassified,
    [],
    `${unclassified.length} agent test(s) carry neither ${GATE_TAG} nor ${MODEL_TAG}. An unclassified `
      + 'test drifts into whichever selection happens to match it, and a reader of a green gate cannot '
      + 'tell which tier ran it. See openwiki/invariants/testing-tiers.md.\n  '
      + unclassified.join('\n  '),
  );
});

test('the two tiers partition the agent tests — union complete, intersection empty', () => {
  let gate = 0;
  let model = 0;
  let total = 0;

  for (const file of agentSpecFiles()) {
    for (const decl of testDeclarations(readFileSync(join(E2E_DIR, file), 'utf8'))) {
      total += 1;
      const c = classify(decl);
      if (c.gate) gate += 1;
      if (c.model) model += 1;
    }
  }

  assert.equal(gate + model, total, `partition is not complete: ${gate} + ${model} !== ${total}`);
  assert.ok(gate > 0, 'no agent test blocks a merge — the gate would prove nothing about the assistant');
  assert.ok(
    model > 0,
    'no agent test is tagged model-decision. Either the classification was not applied, or the split '
      + 'is pointless — both are worth failing on.',
  );
});

test('nothing was skipped or .only-ed to achieve the split', () => {
  // 051 SC-001 and 054 FR-017: a spec may not be skipped, deselected or deleted to reach green, and
  // a tier is not an exception. `.only` would silently deselect every OTHER test in the file.
  const offenders = [];
  for (const file of agentSpecFiles()) {
    const text = readFileSync(join(E2E_DIR, file), 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/^\s*test\.only\s*\(|^\s*test\.describe\.only\s*\(/.test(line)) offenders.push(`${file}:${i + 1} .only`);
      if (/^\s*test\.skip\s*\(\s*['"`]/.test(line)) offenders.push(`${file}:${i + 1} test.skip`);
    });
  }
  assert.deepEqual(offenders, [], `skipped or .only-ed agent tests:\n  ${offenders.join('\n  ')}`);
});

test('the tier selection lives in the CONFIG, because --grep-invert does not work here', () => {
  // MEASURED 2026-08-12, Playwright 1.60: `--grep CORS` lists 1 test and `--grep-invert CORS` lists
  // ALL 177. The flag is accepted and does nothing. A workflow built on it would have run the whole
  // suite in the "gate" selection — the split would have been a silent no-op that looked correct,
  // which is the exact failure mode this whole cluster of work exists to remove.
  //
  // So the selection is `grepInvert`/`grep` in playwright.config.ts, applied by the runner itself.
  // This pins it, so nobody "simplifies" it back onto the CLI flag.
  const cfg = readFileSync(resolve(REPO_ROOT, 'frontend/mcm-app/playwright.config.ts'), 'utf8');
  assert.match(cfg, /grepInvert:\s*MODEL_DECISION/,
    'the gate selection no longer excludes @model-decision in the config');
  assert.match(cfg, /grep:\s*MODEL_DECISION/,
    'the model selection no longer selects @model-decision in the config');
  assert.match(cfg, /E2E_TIER/, 'the tier switch is gone from the config');
});

test('app-ci runs BOTH tiers, and only the gate can fail the job', () => {
  // FR-005: nothing leaves the gate without a tier that runs it. A model tier that is absent from the
  // workflow is quarantine, which 051 SC-001 and 054 FR-017 both forbid.
  const yaml = readFileSync(resolve(REPO_ROOT, '.forgejo/workflows/app-ci.yml'), 'utf8');
  assert.match(yaml, /E2E_TIER=gate/, 'app-ci does not run the gate tier');
  assert.match(yaml, /E2E_TIER=model/, 'app-ci does not run the model tier — that would be quarantine');

  // The model tier must not be able to fail the job, or the split achieves nothing.
  const at = yaml.indexOf('E2E_TIER=model');
  const stepStart = yaml.lastIndexOf('- name:', at);
  assert.match(yaml.slice(stepStart, at), /continue-on-error:\s*true/,
    'the model tier can fail app-e2e — the gate would still be hostage to model drift');
});

/**
 * Locators whose text is written by the MODEL, not by the app. Asserting on their content is
 * asserting on wording the model is free to vary.
 */
const MODEL_OUTPUT_LOCATOR = /assistant-msg-assistant/;
const TEXT_ASSERTION = /\.(toContainText|toHaveText|toMatch)\s*\(/;

/** Test bodies, sliced from one `test(` declaration to the next. Crude on purpose, like the rest. */
function testBodies(text) {
  const lines = text.split('\n');
  const starts = [];
  lines.forEach((l, i) => { if (/^\s*test\s*\(/.test(l)) starts.push(i); });
  return starts.map((start, n) => ({
    line: start + 1,
    head: lines.slice(start, start + 3).join('\n'),
    body: lines.slice(start, n + 1 < starts.length ? starts[n + 1] : lines.length),
  }));
}

/**
 * Prose assertions on model output, inside `@gate` tests.
 *
 * The DISCRIMINATOR IS THE LOCATOR, not the string. `toContainText('Pirates')` against an approval
 * card is asserting what the app rendered; the same call against `assistant-msg-assistant` is
 * asserting how the model phrased itself. A string heuristic cannot tell those apart and would
 * either miss real cases or ban legitimate ones.
 */
export function findProseAssertions(text, file = '<memory>') {
  const found = [];
  for (const { line, head, body } of testBodies(text)) {
    if (!head.includes(GATE_TAG)) continue;
    // A locator bound to a name first, then asserted on, is the same violation wearing a variable.
    const aliases = new Set();
    for (const l of body) {
      const m = l.match(/(?:const|let)\s+(\w+)\s*=.*assistant-msg-assistant/);
      if (m) aliases.add(m[1]);
    }
    body.forEach((l, k) => {
      const direct = MODEL_OUTPUT_LOCATOR.test(l) && TEXT_ASSERTION.test(l);
      const aliased = TEXT_ASSERTION.test(l)
        && [...aliases].some((a) => new RegExp(`expect\\(\\s*${a}\\b`).test(l));
      if (direct || aliased) found.push(`${file}:${line + k} (test at line ${line})`);
    });
  }
  return found;
}

export function proseAssertionsInGateTests() {
  return agentSpecFiles().flatMap((file) =>
    findProseAssertions(readFileSync(join(E2E_DIR, file), 'utf8'), file));
}

test('no @gate test asserts on the MODEL\'s wording', () => {
  // Item #323. `assistant-add-ambiguous.spec.ts` required the word "matches"; the model answered
  // with a raw JSON blob and the tier that BLOCKS A MERGE went red on a run where nothing was
  // broken. The locator polled 283 times against a present, stable element — it was never waiting
  // for the app, it was waiting for a particular sentence.
  //
  // A tier split only holds if the classification is right, so this is enforced rather than
  // reviewed: `@gate` may assert on a testid, a route, or DOM/DB state — never on prose. Anything
  // that genuinely needs the model's wording belongs in `@model-decision`, which does not gate.
  const found = proseAssertionsInGateTests();
  assert.deepEqual(
    found,
    [],
    `${found.length} @gate assertion(s) read the model's own words. Assert on a stable affordance `
      + `(a testid, a route, DB state) or move the test to ${MODEL_TAG}. `
      + 'See openwiki/invariants/testing-tiers.md.\n  ' + found.join('\n  '),
  );
});

// The detector is only worth having if it still fires. A guard that has quietly stopped matching
// reads exactly like a codebase with no violations — this repository's most expensive failure shape
// — so the detector is exercised against samples rather than trusted because the real files pass.
const GATE_HEAD = "test('x', { tag: '@gate' }, async ({ page }) => {";
const MODEL_HEAD = "test('x', { tag: '@model-decision' }, async ({ page }) => {";

test('(#323-meta) the detector CATCHES a direct prose assertion in a @gate test', () => {
  const sample = [
    GATE_HEAD,
    `  await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText('matches');`,
    '});',
  ].join('\n');
  assert.equal(findProseAssertions(sample).length, 1, 'the exact shape from item #323 was not caught');
});

test('(#323-meta) it catches the ALIASED form too — a violation wearing a variable', () => {
  const sample = [
    GATE_HEAD,
    `  const lastMsg = page.locator('[data-testid="assistant-msg-assistant"]').last();`,
    `  await expect(lastMsg).toContainText('Avatar');`,
    '});',
  ].join('\n');
  assert.equal(findProseAssertions(sample).length, 1, 'binding the locator to a name evaded the check');
});

test('(#323-meta) it does NOT flag the same assertion in a @model-decision test', () => {
  const sample = [
    MODEL_HEAD,
    `  await expect(page.locator('[data-testid="assistant-msg-assistant"]').last()).toContainText('matches');`,
    '});',
  ].join('\n');
  assert.deepEqual(findProseAssertions(sample), [],
    'the model tier exists precisely to hold these — flagging them there would delete the tier');
});

test('(#323-meta) it does NOT flag text assertions on APP-rendered affordances', () => {
  // The discriminator is the LOCATOR. An approval card's contents are rendered by the app from
  // data, so asserting them is asserting on behaviour, not on phrasing.
  const sample = [
    GATE_HEAD,
    `  await expect(page.locator('[data-testid="approval-request"]')).toContainText('Pirates');`,
    `  await expect(page.locator('[data-testid="collection-name"]')).toHaveText('My Films');`,
    '});',
  ].join('\n');
  assert.deepEqual(findProseAssertions(sample), []);
});

test('(#323-meta) the replacements actually used are not themselves violations', () => {
  const sample = [
    GATE_HEAD,
    `  const repliesBefore = await page.locator('[data-testid="assistant-msg-assistant"]').count();`,
    `  await expect.poll(() => page.locator('[data-testid="assistant-msg-assistant"]').count()).toBeGreaterThan(repliesBefore);`,
    '});',
  ].join('\n');
  assert.deepEqual(findProseAssertions(sample), [],
    'counting replies is model-invariant — banning it would leave no way to wait for a turn');
});

/**
 * Locators that exist ONLY when the model took a particular branch.
 *
 * `selection-options` is rendered by the `render_selection` component, which the agent emits only
 * when it decides to offer a choice rather than resolving directly. The testid is perfectly stable —
 * which is exactly why the prose rule above does not catch it. What varies is not the model's
 * WORDING but WHICH BRANCH it took, and a `@gate` test that waits for this is waiting on a decision.
 */
const MODEL_BRANCH_LOCATOR = /selection-options/;

export function branchAssertionsInGateTests(text, file = '<memory>') {
  const found = [];
  for (const { line, head, body } of testBodies(text)) {
    if (!head.includes(GATE_TAG)) continue;
    body.forEach((l, k) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;           // a comment mentioning it is not an assertion
      if (MODEL_BRANCH_LOCATOR.test(l)) found.push(`${file}:${line + k} (test at line ${line})`);
    });
  }
  return found;
}

/**
 * The `selection-options` waits that existed in `@gate` when this guard was written.
 *
 * **EMPTY as of feature 064 — all three are gone, and the list may never grow again.**
 *
 * They were grandfathered rather than accepted because re-tiering them was attempted and WITHDRAWN:
 * the equivalent MOBILE flows assert the same thing inside the same required `app-e2e` job, and the
 * mobile suite has no tier split, so moving the web tests would have relocated the nondeterminism to
 * a flakier surface (maestro retries each flow 3x with 150 s waits) while costing pre-merge
 * coverage. Measured 2026-09-02: `maestro-agent-flows` burned 45 minutes on exactly this.
 *
 * What actually retired them was NOT a relabelling. Investigating before designing found that the
 * branch is decided by PURE CODE in all three cases — `resolve_tab_collection`, `_resolve_collection`,
 * and a `_run_owned` that emits `render_selection` on both of its branches — and that the turn was
 * being dropped in the CLIENT before it ever reached the gateway, by three components that had never
 * been moved onto the queue features 053/054 added. See `agent-send-path.test.mjs` and item #337.
 *
 * The list is asserted EXACT, so it can only shrink: leave a fixed file listed here and the guard
 * fails. That is item #303's UNMATCHED-ENTRIES lesson applied to a code allowlist, and it is what
 * forced this list to zero rather than letting a stale entry silently re-permit the class.
 */
const KNOWN_BRANCH_WAITS = [];

test('no NEW @gate test waits for the model to take a BRANCH', () => {
  // Item #323 criterion 3, measured over 30 single-worker runs on one unchanged tree: this class
  // produced the only affordance-never-appeared failures — `selection-options` timing out at 150 s
  // because the model resolved directly instead of offering a choice.
  //
  // The rule is NARROWER than "no testids in @gate": app-rendered affordances are exactly what the
  // gate should assert. It bans waiting on an element whose EXISTENCE is the model's choice.
  const offenders = readdirSync(E2E_DIR).filter((f) => AGENT_SPEC.test(f)).sort()
    .flatMap((f) => branchAssertionsInGateTests(readFileSync(join(E2E_DIR, f), 'utf8'), f));
  const unexpected = offenders.filter((o) => !KNOWN_BRANCH_WAITS.some((k) => o.startsWith(k)));
  assert.deepEqual(
    unexpected,
    [],
    `${unexpected.length} NEW @gate assertion(s) wait for a model BRANCH (\`selection-options\` renders `
      + 'only when the model chooses to offer a selection). Assert on something the app renders '
      + `regardless of which branch was taken, or use ${MODEL_TAG}. See item #337.\n  `
      + unexpected.join('\n  '),
  );
});

test('the grandfathered list is EXACT — it can only shrink', () => {
  // A stale entry is not harmless: it silently re-permits the class for a file that no longer needs
  // the exemption. Same failure shape as an allowlist entry that matches nothing (item #303).
  const offenders = readdirSync(E2E_DIR).filter((f) => AGENT_SPEC.test(f)).sort()
    .flatMap((f) => branchAssertionsInGateTests(readFileSync(join(E2E_DIR, f), 'utf8'), f));
  const stale = KNOWN_BRANCH_WAITS.filter((k) => !offenders.some((o) => o.startsWith(k)));
  assert.deepEqual(
    stale,
    [],
    `${stale.length} grandfathered entr(ies) no longer match anything — delete them from `
      + `KNOWN_BRANCH_WAITS and close out that part of item #337:\n  ` + stale.join('\n  '),
  );
});

test('(#323-meta) the branch detector catches a @gate selection wait, and spares @model-decision', () => {
  const gate = [GATE_HEAD, `  await expect(page.locator('[data-testid="selection-options"]')).toBeVisible();`, '});'].join('\n');
  const model = [MODEL_HEAD, `  await expect(page.locator('[data-testid="selection-options"]')).toBeVisible();`, '});'].join('\n');
  assert.equal(branchAssertionsInGateTests(gate).length, 1, 'a @gate branch wait was not caught');
  assert.deepEqual(branchAssertionsInGateTests(model), [], 'the model tier exists to hold these');
});

test('(#323-meta) a COMMENT naming the locator is not an assertion', () => {
  // The reclassified tests each explain themselves in a comment that names the locator; a detector
  // that flagged prose would fail on its own documentation and get deleted.
  const sample = [GATE_HEAD, `  // selection-options renders only when the model offers a choice`, '});'].join('\n');
  assert.deepEqual(branchAssertionsInGateTests(sample), []);
});

test('(#323-meta) app-rendered affordances stay assertable in @gate', () => {
  const sample = [GATE_HEAD,
    `  await expect(page.locator('[data-testid="import-preview"]')).toBeVisible();`,
    `  await expect(page.locator('[data-testid="movie-detail-title"]')).toContainText('X');`, '});'].join('\n');
  assert.deepEqual(branchAssertionsInGateTests(sample), [],
    'the gate must keep asserting what the app renders — this rule is narrow by design');
});

/**
 * The branch wait moved into a HELPER, so the rule has to follow it there.
 *
 * `setup/assistant-turn.ts` gives `@gate` specs a model-invariant way to wait for a turn
 * (`awaitTurn` — the reply count rises) and a way to look at what that turn produced
 * (`offeredSelection` — a SHORT grace window, then null). Used together they are exactly the
 * supported shape item #337 asked for.
 *
 * Used apart, `offeredSelection` is the old defect with a new name: a spec that reaches for it
 * without first waiting for the turn is back to spending its budget discovering that a branch was
 * not taken, and its red says "not offered" when the truth may be "never answered". The two failures
 * are different — one is a model decision, the other was a dropped client send that blocked two
 * pull requests — and keeping them distinguishable is the whole point of the split.
 */
const TURN_WAIT = /\b(awaitTurn|sendAndAwaitTurn)\s*\(/;
const BRANCH_LOOK = /\bofferedSelection\s*\(/;

export function unwaitedBranchLooks(text, file = '<memory>') {
  const found = [];
  for (const { line, head, body } of testBodies(text)) {
    if (!head.includes(GATE_TAG)) continue;
    let waited = false;
    body.forEach((l, k) => {
      if (/^\s*(\/\/|\*)/.test(l)) return;
      if (TURN_WAIT.test(l)) waited = true;
      else if (BRANCH_LOOK.test(l) && !waited) found.push(`${file}:${line + k} (test at line ${line})`);
    });
  }
  return found;
}

test('a @gate test never looks for a branch before waiting for the turn', () => {
  const offenders = agentSpecFiles()
    .flatMap((f) => unwaitedBranchLooks(readFileSync(join(E2E_DIR, f), 'utf8'), f));
  assert.deepEqual(
    offenders,
    [],
    `${offenders.length} @gate test(s) call offeredSelection() without an awaitTurn() first. `
      + 'Wait for the turn, THEN look at what it produced — otherwise "the branch was not offered" '
      + 'and "the assistant never answered" are the same red again, which is how item #337 was '
      + 'misdiagnosed for three sessions. See tests/e2e/web/setup/assistant-turn.ts.\n  '
      + offenders.join('\n  '),
  );
});

test('(#337-meta) the ordering detector catches a look with no wait, and spares a correct one', () => {
  const bad = [GATE_HEAD, '  const options = await offeredSelection(page);', '});'].join('\n');
  const good = [
    GATE_HEAD,
    '  await awaitTurn(page, before);',
    '  const options = await offeredSelection(page);',
    '});',
  ].join('\n');
  assert.equal(unwaitedBranchLooks(bad).length, 1, 'an unwaited branch look was not caught');
  assert.deepEqual(unwaitedBranchLooks(good), [], 'the supported shape must not be flagged');
});

test('(#337-meta) the ordering rule does not apply to @model-decision', () => {
  const sample = [MODEL_HEAD, '  const options = await offeredSelection(page);', '});'].join('\n');
  assert.deepEqual(unwaitedBranchLooks(sample), [],
    'the model tier exists to hold branch-dependent assertions — flagging them there deletes it');
});
