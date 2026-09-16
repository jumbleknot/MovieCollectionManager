// Item #463 — a live document must not send a reader after a `.env*.example` that is not there.
//
// Why this exists as a CLASS guard rather than a one-line doc fix. This is the second time the
// identical defect has been found and the third and fourth live instances were only found while
// fixing it:
//
//   docs/runbooks/agent-layer.md          → agents/movie-assistant/.env.local.example   (item #463)
//   agents/movie-assistant/README.md ×2   → .env.local.example                          (item #463)
//   docs/MCM-Architecture.md              → …/keycloak/.env.local.example  — superseded by
//                                           feature 022's gen-dev-secrets.mjs
//   infrastructure-as-code/docker/keycloak/README.md → auth.env.example — real path is
//                                           …/docker/stacks/auth.env.example
//
// and feature 048 had already fixed the same shape once, in gen-dev-env.mjs's own advice ("The old
// advice here pointed at a `.env.example` that does not exist in this repository"). A reader who
// follows a dangling pointer does not conclude "the doc is stale" — they conclude the repository is
// broken, or worse, invent the file's contents. For agents/movie-assistant/.env.local that is the
// ONLY route to the file: gen-dev-env.mjs deliberately never writes it (item #227), because it
// carries the operator's own Anthropic credential.
//
// TRACKED, not merely present. The check is `git ls-files`, not `existsSync`. .gitignore's
// `*.env.*` rule ignores every one of these templates by default, so each needs an explicit
// carve-out; without one the file exists on the author's machine, the doc reads fine to them, and
// a fresh clone still has nothing. `existsSync` cannot tell those two states apart.
//
// SCOPE — deliberately narrow, and the narrowness is the point:
//   IN   docs/**            minus docs/proposals/** — the runbooks and architecture docs a reader
//                           is told to follow.
//   IN   **/README.md       minus specs/ and openwiki/ — a component README is the doc a developer
//                           standing in that directory actually opens.
//   OUT  specs/**           frozen SDD artifacts. They record what was true when the feature
//                           shipped; a citation there is history, not an instruction. Scanning
//                           them yields ~80 hits, all of them correct-as-history.
//   OUT  docs/proposals/**  pre-decision documents, exempt from the SDD gate for the same reason.
//   OUT  openwiki/**        generated from sources and gated by okf-lint; fixing a citation there
//                           means fixing the source it was derived from.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Every `.env…​.example`-shaped token, whether or not it is in backticks — the MCM-Architecture.md
 *  instance was inside a fenced shell comment, so a backtick-only pattern would have missed it. */
const CITATION = /[A-Za-z0-9_@<>*!…./-]*\.env[A-Za-z0-9_.-]*\.example/g;

/** `*`, `<stack>`, a leading `!` (a .gitignore line quoted in prose) and `…` are patterns, not paths. */
const IS_PATTERN = /[*<>!…]/;

/**
 * Citations that deliberately name a file that does NOT exist. An entry is a claim about the prose,
 * not a way to silence the gate: the test below FAILS if the cited path turns out to resolve after
 * all, so a stale entry cannot sit here unnoticed.
 */
const DELIBERATELY_ABSENT = {
  'docs/runbooks/local-dev.md:.env.example':
    'feature 048 post-mortem prose. The sentence is ABOUT the dangling pointer — "The generator ' +
    'then advised copying `.env.example`, **which does not exist in this repository**, sending ' +
    'the reader after a missing file rather than at the real cause." Creating the file would ' +
    'destroy the meaning of the paragraph.',
};

/** Tracked markdown, in scope as described above. */
function inScopeDocs() {
  const all = execFileSync('git', ['ls-files', '*.md'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  return all.filter(
    (f) =>
      (f.startsWith('docs/') && !f.startsWith('docs/proposals/')) ||
      (/(^|\/)README\.md$/.test(f) && !f.startsWith('specs/') && !f.startsWith('openwiki/')),
  );
}

/** The set of `.env*.example` paths a fresh clone actually has. */
function trackedExamples() {
  return new Set(
    execFileSync('git', ['ls-files', '*.env*.example'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean),
  );
}

/** Every non-pattern citation in scope, resolved to a repo-relative path. */
function citations() {
  const out = [];
  for (const file of inScopeDocs()) {
    const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
    for (const m of text.matchAll(CITATION)) {
      const cite = m[0];
      if (IS_PATTERN.test(cite)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      // A bare `.env.local.example` in agents/movie-assistant/README.md means the one beside it,
      // so try the document's own directory as well as the repo root.
      const candidates = [cite, relative(REPO_ROOT, resolve(REPO_ROOT, dirname(file), cite))];
      out.push({ file, line, cite, candidates });
    }
  }
  return out;
}

test('#463: the scan actually covers the live docs — an empty scope would pass vacuously', () => {
  const docs = inScopeDocs();
  assert.ok(docs.length >= 20, `expected the live docs to be in scope, found ${docs.length} files`);
  assert.ok(
    docs.includes('docs/runbooks/agent-layer.md') && docs.includes('agents/movie-assistant/README.md'),
    'the two documents item #463 was filed against must be in scope',
  );
  assert.ok(citations().length >= 4, 'expected several .env*.example citations to check');
});

test('#463: every `.env*.example` a live doc cites is TRACKED in the repository', () => {
  const tracked = trackedExamples();
  assert.ok(tracked.size >= 7, `expected the tracked templates to be found, got ${tracked.size}`);

  const dangling = [];
  for (const { file, line, cite, candidates } of citations()) {
    if (candidates.some((c) => tracked.has(c))) continue;
    if (`${file}:${cite}` in DELIBERATELY_ABSENT) continue;
    dangling.push(`${file}:${line}  cites  ${cite}`);
  }
  assert.deepEqual(
    dangling,
    [],
    'these documents send a reader after a `.env*.example` that no fresh clone has — item #463:\n  ' +
      dangling.join('\n  ') +
      '\n\nFix the CITATION or add the FILE (and its .gitignore carve-out — `*.env.*` ignores it ' +
      'by default). Only add an entry to DELIBERATELY_ABSENT when the prose is about the absence.',
  );
});

test('#463: a DELIBERATELY_ABSENT entry that has started resolving is a stale silencer', () => {
  const tracked = trackedExamples();
  for (const [key, reason] of Object.entries(DELIBERATELY_ABSENT)) {
    assert.ok(reason.length > 40, `the exception for ${key} must carry a real reason, not a placeholder`);
    const [file, cite] = [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)];
    const candidates = [cite, relative(REPO_ROOT, resolve(REPO_ROOT, dirname(file), cite))];
    assert.ok(
      !candidates.some((c) => tracked.has(c)),
      `${key} is listed as deliberately absent, but the file now exists — drop the entry so the ` +
        'citation is checked like every other one.',
    );
    assert.ok(
      citations().some((c) => c.file === file && c.cite === cite),
      `${key} is listed as deliberately absent, but no such citation is in the docs any more — ` +
        'drop the entry rather than leaving a rule with nothing to except.',
    );
  }
});

test('#463: the agent gateway template is tracked — it is the only route to that .env.local', () => {
  // gen-dev-env.mjs deliberately never writes agents/movie-assistant/.env.local (item #227), so
  // unlike every other env file in the repository there is no command that produces it. If this
  // template stops being tracked, a fresh clone has no way at all to learn what the gateway reads.
  assert.ok(
    trackedExamples().has('agents/movie-assistant/.env.local.example'),
    'agents/movie-assistant/.env.local.example must be tracked. .gitignore `*.env.*` ignores it by ' +
      'default — the `!agents/movie-assistant/.env.local.example` carve-out is what keeps it in.',
  );
});
