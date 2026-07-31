#!/usr/bin/env node
// OpenWiki maintenance orchestrator — feature 044.
//
// Usage:
//   node scripts/wiki-maintain.mjs --plan [--since <ref>] [--json]
//   node scripts/wiki-maintain.mjs --execute [--max-slices <n>] [--dry-run]
//   node scripts/wiki-maintain.mjs --selftest
//
// Exit codes: 0 planned / all attempted slices verified / nothing to do · 1 a slice failed
// verification · 2 bad usage, unreadable state, or a missing credential on --execute · 3 stopped at
// the budget ceiling with work outstanding — NOT a failure.
//
// Contract: specs/044-openwiki-automation-migration/contracts/cli-contracts.md (C1, C6)
// Entities: specs/044-openwiki-automation-migration/data-model.md (E1–E3)
//
// ── The one thing to understand before changing this file ───────────────────────────────────────
// The generator has NO programmatic scoping surface (research R2): `openwiki code --update <message>`
// is the entire interface — no --pages, no --scope, no --max-pages. A slice is therefore an
// INSTRUCTION TO A MODEL, not a constraint on a process, and nothing stops the generator ignoring it.
// Consequently:
//   * Success is judged by pages that landed in the WORKING TREE, plus bundle conformance, plus
//     every written path being permitted by openwiki/policy.yaml.
//   * The generator's exit status is NEVER consulted. Feature 043 measured the failure this exists to
//     end: 12 minutes of paid work, one index.md written, exit 0, reported as success.
//   * The generator reports no token or cost data either (research R1), which is why the budget is
//     pages + wall-clock and why neither is a monetary bound.
//
// ── The budget, declared (FR-011a, FR-011c, FR-011d) ────────────────────────────────────────────
// 16 pages and 20 minutes per run, whichever is reached first, enforced BETWEEN slices so a slice
// under way is never interrupted. The overshoot is therefore bounded at one slice, giving a declared
// effective ceiling of **<=24 pages / ~37 minutes**.
//
// The wall-clock budget bounds runner occupancy (FR-011c): there is one CI runner, app-e2e is ~35
// minutes on it, and a paid documentation job must not squat on that queue.
//
// **NEITHER BUDGET IS A MONETARY BOUND** (FR-011d). OpenWiki emits no token or cost figure, this
// repository has no cost measurements, and no requirement in this feature asserts a spend ceiling.
// Do not describe these as cost controls, and do not add a monetary one back.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { isCoverageTarget, loadPolicy, mayWrite } from './openwiki-policy.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Re-exported so a consumer needs one import, and so the run and the gate provably share one reader.
export { loadPolicy, resolvePolicy, mayWrite, isCoverageTarget } from './openwiki-policy.mjs';

// The run record lives beside the bundle it describes, and is COMMITTED: runners are ephemeral, and
// FR-012 requires the marker to advance even on a run that creates no proposal.
export const STATE_FILE = 'openwiki/.maintenance-state.json';

// Exactly the three outcomes FR-017 requires distinguishing. A credential, capacity or generator
// failure must never be classified as `nothing-to-do` — that would make the cheap path look reachable
// while the work silently never happened.
export const RUN_OUTCOMES = Object.freeze(['nothing-to-do', 'completed', 'failed']);

const EMPTY_RECORD = Object.freeze({
  coveredCommit: null,
  coveredAt: null,
  lastOutcome: null,
  backlog: [],
  proposal: null,
  lastRunBudget: null,
});

const statePath = (root) => join(root, STATE_FILE);

/**
 * Read the run record. An ABSENT file is legitimately "never covered" and reads as the empty record;
 * a PRESENT but malformed one is a hard error. Silently defaulting on corruption would either
 * re-cover history already covered (paid work repeated) or certify history that was never examined.
 */
export function readRunRecord(root = REPO_ROOT) {
  const p = statePath(root);
  if (!existsSync(p)) return { ...EMPTY_RECORD };

  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${STATE_FILE}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${STATE_FILE} does not parse: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${STATE_FILE} must contain a JSON object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`);
  }

  const record = { ...EMPTY_RECORD, ...parsed };
  assertRecordShape(record);
  return record;
}

/** Write the run record, validating first — an invalid record must never reach disk. */
export function writeRunRecord(root = REPO_ROOT, record = {}) {
  const merged = { ...EMPTY_RECORD, ...record };
  assertRecordShape(merged);
  const p = statePath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

function assertRecordShape(record) {
  if (record.lastOutcome !== null && !RUN_OUTCOMES.includes(record.lastOutcome)) {
    throw new Error(`${STATE_FILE}: lastOutcome must be one of ${RUN_OUTCOMES.join(' | ')} (or null), got ${JSON.stringify(record.lastOutcome)}`);
  }
  if (record.coveredCommit !== null && typeof record.coveredCommit !== 'string') {
    throw new Error(`${STATE_FILE}: coveredCommit must be a commit string or null`);
  }
  if (!Array.isArray(record.backlog)) {
    throw new Error(`${STATE_FILE}: backlog must be an array of slices`);
  }
  if (record.proposal !== null && (typeof record.proposal !== 'object' || Array.isArray(record.proposal))) {
    throw new Error(`${STATE_FILE}: proposal must be an object or null`);
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// E1/E2 — the planner
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The largest slice feature 043 delivered reliably — and it delivered it twice (FR-002). Advisory as
 * far as the generator is concerned (research R2); binding on what the planner will ask for.
 */
export const MAX_PAGES_PER_SLICE = 8;

/**
 * The cap for pages that DO NOT EXIST YET, which is much lower — and this was measured, expensively.
 *
 * A slice of 8 brand-new pages was asked for three times and produced NOTHING each time: the
 * generator researches every page first and writes at the end, so with 8 new pages it exhausted its
 * own budget mid-research and exited 0 having written nothing (the last run got as far as printing
 * "Now I have enough evidence for all 8 pages", then stopped). A single new page, asked for on its
 * own, was written in about six minutes.
 *
 * Feature 043's "8 pages delivered reliably, twice" was REFRESHING existing pages, which needs no
 * per-page source investigation. Refreshes still go up to 8; creation does not. FR-002's cap of 8 is
 * a ceiling, not a target, so bounding new-page work below it needs no spec change.
 */
export const MAX_NEW_PAGES_PER_SLICE = 3;

export const DEFAULT_BUNDLE = 'openwiki';

const RESERVED_BUNDLE_FILES = new Set(['index.md', 'INSTRUCTIONS.md', 'log.md', 'quickstart.md']);

/**
 * Where a NEW concept for a changed source belongs. Ordered; first match wins.
 *
 * Only consulted when no existing concept cites the changed path — otherwise the bundle's own
 * `resource` fields decide, which is the mapping that cannot drift.
 */
const AREA_RULES = [
  { test: (p) => p.startsWith('docs/runbooks/'), area: 'runbooks' },
  { test: (p) => p.startsWith('docs/decisions/'), area: 'decisions' },
  { test: (p) => p === 'docs/MCM-Architecture.md', area: 'architecture' },
  { test: (p) => p.startsWith('docs/templates/'), area: 'process' },
  { test: (p) => /^specs\/[^/]+\/HANDOFF\.md$/.test(p), area: 'process' },
  { test: (p) => basename(p) === 'README.md' || p === 'packages/DESIGN-SYSTEM.md', area: 'projects' },
  { test: (p) => p === 'CLAUDE.md' || p === 'AGENTS.md', area: 'invariants' },
];

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').replace(/-+/g, '-').toLowerCase();

/** The concept filename a changed source would get if nothing covers it yet. */
export function conceptNameFor(sourcePath) {
  const name = basename(sourcePath);
  if (name === 'README.md') {
    const parent = basename(dirname(sourcePath));
    return `${kebab(parent === '.' ? 'repository' : parent)}.md`;
  }
  if (name === 'HANDOFF.md') return `${kebab(basename(dirname(sourcePath)))}-handoff.md`;
  return `${kebab(name.replace(/\.md$/i, ''))}.md`;
}

function areaFor(sourcePath) {
  for (const rule of AREA_RULES) if (rule.test(sourcePath)) return rule.area;
  return 'reference';
}

/** Front matter, read directly. Deliberately not reusing the OKF gate: this needs no validation. */
function frontMatter(file) {
  const text = readFileSync(file, 'utf8');
  if (!/^---\r?\n/.test(text)) return {};
  const end = text.indexOf('\n---', 4);
  if (end === -1) return {};
  try {
    const parsed = parseYaml(text.slice(text.indexOf('\n') + 1, end));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Concepts in the bundle, with the source each one cites.
 *
 * Only pages inside an area directory are slice-able: a slice names exactly one area (E1), so a
 * bundle-root page has no area to name.
 */
export function readBundle(bundleRoot) {
  const concepts = [];
  const areas = new Set();
  if (!existsSync(bundleRoot)) return { concepts, areas };

  for (const entry of readdirSync(bundleRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const area = entry.name;
    if (area.startsWith('.')) continue;
    areas.add(area);
    for (const f of readdirSync(join(bundleRoot, area), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!f.isFile() || !f.name.endsWith('.md') || RESERVED_BUNDLE_FILES.has(f.name)) continue;
      const fm = frontMatter(join(bundleRoot, area, f.name));
      concepts.push({
        area,
        page: f.name,
        path: `${area}/${f.name}`,
        resource: typeof fm.resource === 'string' && fm.resource.trim() !== '' ? fm.resource.trim() : null,
      });
    }
  }
  return { concepts, areas };
}

/** Does concept `c` summarize `changedPath`? Its `resource` is either the file or a tree above it. */
function covers(concept, changedPath) {
  if (concept.resource === null) return false;
  const r = concept.resource.replace(/\/+$/, '');
  if (r === changedPath) return true;
  return changedPath.startsWith(`${r}/`);
}

/**
 * Decompose outstanding work into bounded slices.
 *
 * Inputs are the change set since the last recorded run and the carried-forward backlog — never
 * per-concept staleness markers. Feature 043's drift warning fans a single edit to a widely-cited
 * file out across every concept citing it and never clears, which is why FR-036 keeps it report-only
 * and why the trigger here is "what changed since we last looked".
 */
export function planSlices({
  bundleRoot = join(REPO_ROOT, DEFAULT_BUNDLE),
  changedPaths = [],
  backlog = [],
  policy = null,
  allDocPaths = [],
  maxPagesPerSlice = MAX_PAGES_PER_SLICE,
  maxNewPagesPerSlice = MAX_NEW_PAGES_PER_SLICE,
} = {}) {
  const { concepts, areas } = readBundle(bundleRoot);

  // Concept paths that could ONLY have come from a source the policy does not cover.
  //
  // The backlog is COMMITTED and long-lived, so it outlives the policy that produced it. Declaring
  // CLAUDE.md `coverage: false` stopped the planner proposing `invariants/claude.md` from the change
  // set — but the slice already sitting in the backlog was re-planned unchanged on the next run, and
  // it will be re-planned forever: a slice for a page nothing will ever legitimately write can never
  // succeed. Measured on `main`, twice.
  //
  // So carried-forward work is re-validated too. A page is dropped only when NO covered source maps
  // to it, so a name collision between a covered and an uncovered source cannot silently discard
  // real work.
  const uncoveredTargets = new Set();
  const coveredTargets = new Set();
  if (policy !== null) {
    for (const p of allDocPaths) {
      const target = `${areaFor(p)}/${conceptNameFor(p)}`;
      (isCoverageTarget(policy, p) ? coveredTargets : uncoveredTargets).add(target);
    }
  }
  const plannable = (area, page) => {
    const target = `${area}/${page}`;
    return !uncoveredTargets.has(target) || coveredTargets.has(target);
  };
  const dropped = [];

  // area → Map(page → reason). A Map keeps insertion order deterministic and dedupes by page.
  const wanted = new Map();
  const subjectFor = new Map();
  const want = (area, page, reason, subject = null) => {
    if (!plannable(area, page)) {
      dropped.push(`${area}/${page}`);
      return;
    }
    if (!wanted.has(area)) wanted.set(area, new Map());
    const pages = wanted.get(area);
    if (!pages.has(page)) pages.set(page, reason);
    if (subject && !subjectFor.has(page)) subjectFor.set(page, subject);
  };

  // Carried-forward work first: a backlog that keeps losing to fresh changes never drains.
  for (const slice of backlog) {
    if (!slice || typeof slice.area !== 'string' || !Array.isArray(slice.pages)) continue;
    for (const page of slice.pages) want(slice.area, page, slice.reason ?? 'carried forward', slice.subjects?.[page] ?? null);
  }

  const sources = policy === null ? [...changedPaths] : changedPaths.filter((p) => isCoverageTarget(policy, p));
  const uncovered = [];
  for (const source of sources) {
    // A change inside the bundle is not a source change — and treating it as one would make every
    // maintenance run trigger the next (FR-009a).
    if (source.startsWith(`${DEFAULT_BUNDLE}/`)) continue;

    const covering = concepts.filter((c) => covers(c, source));
    if (covering.length > 0) {
      for (const c of covering) want(c.area, c.page, `source changed: ${source}`);
    } else {
      uncovered.push(source);
      want(areaFor(source), conceptNameFor(source), `new source, not yet covered: ${source}`);
    }
  }

  // Existing areas before new ones: extending a directory that is already conformant is the lower-risk
  // work, and a run that stops at its budget should have spent it on that.
  const ordered = [...wanted.keys()].sort((a, b) => {
    const ea = areas.has(a) ? 0 : 1;
    const eb = areas.has(b) ? 0 : 1;
    return ea - eb || a.localeCompare(b);
  });

  const existingPages = new Set(concepts.map((c) => c.path));

  const slices = [];
  for (const area of ordered) {
    const reasons = wanted.get(area);
    const all = [...reasons.keys()];

    // Creation and refresh are different kinds of work with different reliable sizes, so they are
    // never mixed into one slice: a refresh that shared a slice with three new pages would inherit
    // the new pages' failure mode for no reason.
    const refreshes = all.filter((p) => existingPages.has(`${area}/${p}`));
    const creations = all.filter((p) => !existingPages.has(`${area}/${p}`));

    for (const [group, cap, kind] of [[refreshes, maxPagesPerSlice, 'refresh'], [creations, maxNewPagesPerSlice, 'create']]) {
      for (let i = 0; i < group.length; i += cap) {
        const chunk = group.slice(i, i + cap);
        slices.push({
          area,
          pages: chunk,
          kind,
          subjects: Object.fromEntries(chunk.filter((p) => subjectFor.has(p)).map((p) => [p, subjectFor.get(p)])),
          // Derived from the tree, NEVER from the caller: a stale backlog entry claiming an area
          // exists would have the run extend a directory that is not there.
          areaExists: areas.has(area),
          reason: [...new Set(chunk.map((p) => reasons.get(p)))].join('; '),
        });
      }
    }
  }

  slices.uncovered = uncovered;
  // Reported, never silent: work vanishing from a plan without explanation is indistinguishable from
  // work being forgotten.
  slices.dropped = [...new Set(dropped)];
  return slices;
}

/**
 * Characters that must never reach the run message.
 *
 * MEASURED, not defensive: `nx:run-commands` appends `--args` to a shell command line UNQUOTED and
 * the shell then tokenizes it — `--args="--since=one two"` arrives as two argv entries. So the message
 * has to survive one round of shell parsing inside double quotes, where a backtick or `$` would be
 * substituted and a `"` would end the quoting. A single line of plain text does; a markdown-formatted
 * multi-line block with backticks does not.
 */
const SHELL_UNSAFE = /["`$\\\n\r]/g;

/**
 * Render a slice into the free-text instruction the generator is given.
 *
 * **This string is the entire scope boundary.** `openwiki code --update <message>` is the whole
 * interface: there is no `--pages`, no `--scope`, no `--max-pages` (research R2). The generator is
 * free to ignore every word of it, which is exactly why the verifier judges the result from the
 * working tree rather than believing the instruction was honoured.
 *
 * Deliberately ONE LINE and free of shell metacharacters, so that what a reviewer reads in the plan
 * is byte-for-byte what the generator is asked — a "reviewed" message that got re-quoted on its way to
 * the tool would be a scope boundary nobody actually approved.
 *
 * Deterministic for a given slice, for the same reason.
 */
export function renderRunMessage(slice) {
  const { area, pages, areaExists, subjects = {} } = slice;
  // A filename alone forces the generator to work out what the page should say, and that research is
  // what exhausts its budget: three runs died mid-investigation ("Let me read more context around
  // line 251 in CLAUDE.md") having written nothing, while a single page asked for WITH its subject
  // stated was written in six minutes. Where a subject is known, say it.
  const list = pages
    .map((p) => (subjects[p] ? `${DEFAULT_BUNDLE}/${area}/${p} (${subjects[p]})` : `${DEFAULT_BUNDLE}/${area}/${p}`))
    .join('; ');
  const scope = areaExists
    ? `The ${DEFAULT_BUNDLE}/${area}/ directory already exists; leave the pages in it that are not listed above exactly as they are.`
    : `The ${DEFAULT_BUNDLE}/${area}/ directory does not exist yet, so create it.`;

  const message = [
    `Work on exactly one area of the knowledge bundle this run: ${DEFAULT_BUNDLE}/${area}/.`,
    `Write or refresh these pages, each followed by its subject in brackets where given: ${list}.`,
    scope,
    // MEASURED, and it cost three paid runs: an earlier version of this message said "write ONLY
    // those pages and no others", which forbids touching the area index.md — while the conformance
    // gate REQUIRES every concept to be listed there (rule V9). The instruction was therefore
    // unsatisfiable, and the generator resolved the contradiction by writing nothing at all: 393
    // seconds, exit 0, zero pages. Asking for the index update explicitly is what unblocked it.
    `Also update ${DEFAULT_BUNDLE}/${area}/index.md so that every page in that directory is listed there, including the ones above — the conformance gate rejects an unlisted page.`,
    `Do not write anywhere else: no other directory of ${DEFAULT_BUNDLE}/, and nothing outside ${DEFAULT_BUNDLE}/.`,
    `Follow ${DEFAULT_BUNDLE}/INSTRUCTIONS.md: a distilled summary plus the load-bearing gotchas, citing the authoritative source in a resource field where one exists, and no resource field on a page that is authoritative in its own right.`,
    'Where this run relocates existing prose, move it VERBATIM: no abridgement, no rewording, no reordering.',
  ].join(' ');

  return message.replace(SHELL_UNSAFE, ' ').replace(/ {2,}/g, ' ');
}

// ── the plan (E2) ───────────────────────────────────────────────────────────────

const git = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr ?? '').trim()}`);
  return r.stdout.trim();
};

/** Documentation-shaped paths only — the policy classifies them, but reading the whole tree is waste. */
const isDocPath = (p) => /\.(md|markdown)$/i.test(p);

/** Does this ref name a commit that exists in THIS checkout? */
function commitResolves(root, ref) {
  return spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).status === 0;
}

/**
 * Paths changed since `sinceCommit`. A null marker means "never covered", which is a full sweep
 * rather than an empty one — a first run must be able to see the whole tree.
 *
 * An UNRESOLVABLE marker is also a full sweep, not a crash. CI checks out shallow by default
 * (`fetch-depth: 1`), so the committed marker — and anything like `HEAD~1` — simply is not in the
 * clone, and `git diff <marker>..HEAD` dies with "unknown revision". Falling back to the full tree is
 * both safe and correct: the budget bounds what one run attempts, and the alternative is a run that
 * fails for a reason having nothing to do with the documentation. Reported, never silent.
 */
export function changedSince(root, sinceCommit) {
  const sweep = () => git(['ls-files'], root).split('\n').filter(Boolean).filter(isDocPath);
  if (!sinceCommit) return sweep();
  if (!commitResolves(root, sinceCommit)) {
    console.error(`[wiki-maintain] marker \`${sinceCommit}\` is not in this checkout (a shallow clone, or rewritten history) — falling back to a full sweep, bounded by the run budget.`);
    const all = sweep();
    all.sinceResolved = false;
    return all;
  }
  const out = git(['diff', '--name-only', `${sinceCommit}..HEAD`], root);
  return out.split('\n').filter(Boolean).filter(isDocPath);
}

export function computePlan({
  root = REPO_ROOT,
  bundleRoot = null,
  since = null,
  record = null,
  policy = null,
  pageBudget = PAGE_BUDGET,
  now = () => new Date().toISOString(),
} = {}) {
  const runRecord = record ?? readRunRecord(root);
  const sinceCommit = since ?? runRecord.coveredCommit;
  const baseCommit = git(['rev-parse', 'HEAD'], root);
  const changedPaths = changedSince(root, sinceCommit);
  const sinceResolved = changedPaths.sinceResolved !== false;

  const allDocPaths = git(['ls-files'], root).split('\n').filter(Boolean).filter(isDocPath);
  const slices = planSlices({
    bundleRoot: bundleRoot ?? join(root, DEFAULT_BUNDLE),
    changedPaths,
    backlog: runRecord.backlog ?? [],
    policy,
    allDocPaths,
  });

  // What one run can attempt, given the page budget. The rest is `deferred` and carried forward — a
  // plan that pretended a 40-page sweep fits in one run would be lying to its reviewer.
  const attempt = [];
  const deferred = [];
  let pages = 0;
  for (const slice of slices) {
    if (attempt.length > 0 && pages + slice.pages.length > pageBudget) deferred.push(slice);
    else {
      attempt.push(slice);
      pages += slice.pages.length;
    }
  }

  const withMessages = attempt.map((s) => ({ ...s, runMessage: renderRunMessage(s) }));

  return {
    generatedAt: now(),
    baseCommit,
    sinceCommit: sinceCommit ?? null,
    sinceResolved,
    missingEventDocuments: detectMissingEventDocuments({ root, sinceCommit, changedPaths, policy }),
    changedPaths: policy === null ? changedPaths : changedPaths.filter((p) => isCoverageTarget(policy, p)),
    slices: withMessages,
    deferred: deferred.map((s) => ({ ...s, runMessage: renderRunMessage(s) })),
    plannedPages: pages,
    uncovered: slices.uncovered ?? [],
    dropped: slices.dropped ?? [],
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// FR-009 — when a merge should actually trigger a run
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Debounce: wait for ~15 quiet minutes on the default branch, so a burst of merges produces ONE run
// rather than one per merge. In the workflow this is `concurrency` + `cancel-in-progress` + an initial
// sleep: a new push cancels the waiter and a fresh one starts (research R3).
//
// Maximum deferral: a merge stream that never goes quiet would otherwise starve maintenance exactly
// when drift is fastest. So beyond a ceiling the wait is skipped. The age is derived from GIT — the
// commit date of the oldest commit the run record has not covered — because the waiting run gets
// CANCELLED, and any timer it was holding dies with it. Git state survives cancellation; run state
// does not, and that is the whole reason this is computed the way it is.

export const DEBOUNCE_SECONDS = 15 * 60;
export const MAX_DEFERRAL_SECONDS = 6 * 60 * 60;

/**
 * Should this trigger wait for the quiet period, or run now?
 *
 * At-or-above the threshold it RUNS: a strict `>` would let a stream that keeps the age pinned exactly
 * at the ceiling defer forever.
 */
export function shouldDeferMaintenance({
  oldestUncoveredAgeSeconds = null,
  dispatched = false,
  maxDeferralSeconds = MAX_DEFERRAL_SECONDS,
} = {}) {
  if (dispatched) return { defer: false, reason: 'manually dispatched — the debounce is bypassed (FR-009c)' };
  if (oldestUncoveredAgeSeconds === null) {
    return { defer: true, reason: 'nothing uncovered — there is nothing to hurry for' };
  }
  if (oldestUncoveredAgeSeconds >= maxDeferralSeconds) {
    return {
      defer: false,
      reason: `the oldest uncovered commit is ${Math.round(oldestUncoveredAgeSeconds / 60)} min old, at or past the ${Math.round(maxDeferralSeconds / 60)}-min maximum deferral — running now`,
    };
  }
  return {
    defer: true,
    reason: `the oldest uncovered commit is ${Math.round(oldestUncoveredAgeSeconds / 60)} min old, within the maximum deferral — waiting for a quiet period`,
  };
}

/** The age of the oldest commit the run record has not covered, in seconds. Git-derived. */
export function oldestUncoveredAgeSeconds({ root = REPO_ROOT, record = null, nowMs = null } = {}) {
  const runRecord = record ?? readRunRecord(root);
  if (!runRecord.coveredCommit) {
    // Never covered: the oldest uncovered commit is the first commit in the range, so the run should
    // not be deferred indefinitely on a fresh checkout either.
    const first = spawnSync('git', ['log', '--reverse', '--format=%ct', '--max-count=1'], { cwd: root, encoding: 'utf8' });
    if (first.status !== 0 || !first.stdout.trim()) return null;
    return Math.max(0, Math.floor((nowMs ?? Date.now()) / 1000) - Number(first.stdout.trim().split('\n')[0]));
  }
  const r = spawnSync('git', ['log', '--reverse', '--format=%ct', `${runRecord.coveredCommit}..HEAD`], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const first = r.stdout.trim().split('\n').filter(Boolean)[0];
  if (!first) return null;
  return Math.max(0, Math.floor((nowMs ?? Date.now()) / 1000) - Number(first));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// FR-026f — an event-driven path whose event happened, but whose document does not exist
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// An `event-driven` path is NOT satisfied by being left alone. A decision reached produces a NEW
// decision record; if the decision landed and no record did, the missing record IS the finding.
//
// This repository records decisions in exactly two places, so those are the two the detector reads:
// a `## Clarifications` entry in a feature's spec, and a Complexity Tracking row in its plan.
//
// Reported, never silent — and never blocking. Blocking a documentation run on a judgement call about
// whether something deserved an ADR would make the run a nuisance, and a nuisance gets switched off.

const CLARIFICATION_ENTRY = /^\s*-\s*(?:\*\*)?Q(?:\*\*)?\s*[:.]/im;

function fileAt(root, rev, path) {
  const r = spawnSync('git', ['show', `${rev}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout : null;
}

/** The lines of `## <heading>`'s section, or [] when the section is absent. */
function section(text, heading) {
  if (text === null) return [];
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^#{1,4}\\s+${heading}\\b`, 'i').test(l));
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s+/.test(l));
  return end === -1 ? rest : rest.slice(0, end);
}

const countClarifications = (text) => section(text, 'Clarifications').filter((l) => CLARIFICATION_ENTRY.test(l)).length;

const countComplexityRows = (text) => section(text, 'Complexity Tracking')
  .filter((l) => /^\s*\|/.test(l) && !/^\s*\|\s*-+/.test(l))
  // Drop the header row and any all-dash separator; what remains is a claimed deviation.
  .filter((l) => !/\|\s*Violation\s*\|/i.test(l))
  .length;

/**
 * Compare the two revisions rather than parsing a diff. Hunk headers do not reliably carry the
 * enclosing markdown section, so "was this line added under ## Clarifications?" is not answerable from
 * a diff without guessing — whereas counting the section at both ends is exact.
 */
export function detectMissingEventDocuments({ root = REPO_ROOT, sinceCommit = null, changedPaths = null, policy = null } = {}) {
  if (!sinceCommit) return [];

  const changed = changedPaths ?? changedSince(root, sinceCommit);
  const decisionRecordTouched = changed.some((p) => p.startsWith('docs/decisions/'));

  const findings = [];
  const specs = changed.filter((p) => /^specs\/[^/]+\/spec\.md$/.test(p));
  const plans = changed.filter((p) => /^specs\/[^/]+\/plan\.md$/.test(p));

  for (const [paths, count, what] of [
    [specs, countClarifications, 'a clarification was recorded'],
    [plans, countComplexityRows, 'a Complexity Tracking deviation was recorded'],
  ]) {
    for (const path of paths) {
      const before = count(fileAt(root, sinceCommit, path));
      const after = count(readFileSync(join(root, path), 'utf8'));
      if (after > before && !decisionRecordTouched) {
        findings.push({
          path: 'docs/decisions/**',
          policy: 'event-driven',
          source: path,
          reason: `${what} in ${path} (${before} → ${after}) but no decision record was added or amended`,
          suggestion: 'consider adding a decision record, or note why this decision does not warrant one',
          blocking: false,
        });
      }
    }
  }

  return findings;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// E6/FR-013/FR-016 — the maintenance proposal
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// ONE long-lived branch, ONE open proposal, ever. A run that finds a proposal open EXTENDS it rather
// than opening a second, and it does so by REBASE-AND-APPEND: rebase the branch onto the base, then
// add a commit. Never a wholesale force-replace of the branch content, because a reviewer's
// remediation commit lives there and must survive every subsequent update (FR-016a).
//
// NEVER auto-merged (FR-013). A human reviews every wiki diff; there is no merge call in this file,
// and the proposal is gated by the repository's normal guardrails like any hand-authored change.

export const PROPOSAL_BRANCH = 'openwiki-maintenance';
export const PROPOSAL_TITLE = 'docs(openwiki): scheduled knowledge-bundle maintenance';

const gitRunner = (root) => (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });

function gitOrThrow(git, args, what) {
  const r = git(...args);
  if (r.status !== 0) throw new Error(`${what} failed: git ${args.join(' ')}: ${(r.stderr || r.stdout || '').trim()}`);
  return r.stdout.trim();
}

const branchExists = (git, branch) => git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).status === 0;

/**
 * Get the proposal branch ready to be GENERATED ONTO, before the run starts.
 *
 * The ordering here is load-bearing and was got wrong first: generating on the base branch and then
 * moving the result across cannot work once a proposal is open, because the run's `index.md` is built
 * against the base's bundle while the branch already holds earlier, unmerged pages — the two versions
 * conflict on every reapply. Measured as `could not reapply the run's changes`.
 *
 * Generating ON the branch instead makes each run a natural continuation of the last, and removes the
 * stash dance entirely.
 */
export function prepareProposalBranch({
  root = REPO_ROOT,
  baseBranch = 'main',
  branch = PROPOSAL_BRANCH,
  git = null,
} = {}) {
  const g = git ?? gitRunner(root);
  // The RUN RECORD is exempt: it is bookkeeping that never travels on this branch, so it is expected
  // to be modified at exactly this moment — the run has just read or updated it. Everything else being
  // dirty means generation already happened, which is the ordering mistake this check exists to catch.
  const dirty = g('status', '--porcelain').stdout.split('\n')
    .map((l) => l.slice(3).trim())
    .filter((f) => f !== '' && f !== STATE_FILE);
  if (dirty.length > 0) {
    throw new Error(`the working tree is dirty (${dirty.slice(0, 3).join(', ')}) — prepare the proposal branch before generating, not after`);
  }

  if (!branchExists(g, branch)) {
    gitOrThrow(g, ['checkout', '-b', branch], 'creating the proposal branch');
    return { branch, created: true, rebased: false };
  }

  gitOrThrow(g, ['checkout', branch], 'switching to the proposal branch');
  // Rebase, never reset: a reviewer's remediation commit on this branch is REPLAYED, not discarded,
  // which is what "rebased and appended, never wholesale force-replaced" means in practice (FR-016a).
  const rebase = g('rebase', baseBranch);
  if (rebase.status !== 0) {
    g('rebase', '--abort');
    g('checkout', baseBranch);
    throw new Error(`the proposal branch does not rebase cleanly onto ${baseBranch} — a human needs to resolve it`);
  }
  return { branch, created: false, rebased: true };
}

/**
 * Commit what the run produced onto the proposal branch and make sure exactly ONE open proposal
 * describes it — extending the existing one rather than opening a second (FR-016).
 *
 * `git` and `forge` are injected so the whole lifecycle is testable without a forge or a network.
 * `remote` is null by default: pushing is a CI concern, and a local run must not write to the shared
 * repository as a side effect.
 */
/**
 * The open proposal for `branch`, according to the FORGE — not according to the run record.
 *
 * FR-016 requires at most one open proposal ever, and the run record is only a cache of that fact. A
 * cache that can be lost: the record is committed by a step that can fail (the marker push races
 * `main`, which it did), so a run can create a proposal and then lose the pointer to it. The next run
 * then tries to open a SECOND one — measured, and it survived only because the forge answered 409.
 *
 * Asking the forge makes the invariant hold regardless of what the record says, and makes a run that
 * lost its record self-healing rather than permanently stuck.
 */
export function findOpenProposal(forge, branch) {
  if (typeof forge.listPulls !== 'function') return null;
  const open = forge.listPulls({ state: 'open' }) ?? [];
  return open.find((p) => (p.head?.ref ?? p.head) === branch) ?? null;
}

export function publishProposal({
  root = REPO_ROOT,
  record = null,
  forge,
  baseBranch = 'main',
  branch = PROPOSAL_BRANCH,
  title = PROPOSAL_TITLE,
  body = '',
  slices = [],
  remote = null,
  git = null,
  returnTo = null,
  now = () => new Date().toISOString(),
} = {}) {
  const g = git ?? gitRunner(root);
  const runRecord = record ?? readRunRecord(root);
  const markerBefore = runRecord.coveredCommit ?? null;

  // The record first (cheap), then the forge (authoritative). Either can tell us a proposal is open;
  // only the forge can tell us so after the record was lost.
  let existing = runRecord.proposal?.number ? forge.getPull(runRecord.proposal.number) : null;
  if (!existing || existing.state !== 'open') existing = findOpenProposal(forge, branch);
  const reuse = Boolean(existing && existing.state === 'open');

  gitOrThrow(g, ['add', '-A'], 'staging the maintenance changes');
  // The RUN RECORD never travels on the proposal branch. It advances on the base branch through its
  // own `[skip ci]` commit, so committing it here as well guarantees a conflict on the next rebase —
  // measured exactly that. The proposal carries bundle CONTENT; the marker is base-branch bookkeeping.
  g('reset', '--quiet', '--', STATE_FILE);

  const staged = g('diff', '--cached', '--quiet').status !== 0;
  if (staged) gitOrThrow(g, ['commit', '-m', `${title}\n\n${body}`.trim()], 'committing the maintenance changes');
  const headCommit = gitOrThrow(g, ['rev-parse', 'HEAD'], 'reading the branch head');

  if (remote) {
    // A rebase rewrites history, so the push needs force — but --force-with-lease, which REFUSES to
    // clobber a commit that appeared on the remote since we last looked. That is the whole difference
    // between "rebased and appended" and "overwrote the reviewer's work".
    gitOrThrow(g, ['push', '--force-with-lease', remote, branch], 'pushing the proposal branch');
  }

  const pull = reuse
    ? forge.updatePull(existing.number, { body, title })
    : forge.createPull({ head: branch, base: baseBranch, title, body });

  if (returnTo) gitOrThrow(g, ['checkout', returnTo], `returning to ${returnTo}`);

  return {
    branch,
    number: pull.number,
    headCommit,
    // Remembered so a closed-unmerged proposal can roll the marker back to where it stood BEFORE the
    // work was proposed. Without it there is nothing to roll back to, and the gap is invisible.
    markerBefore: runRecord.proposal?.markerBefore ?? markerBefore,
    slices: [...(runRecord.proposal?.slices ?? []), ...slices],
    updatedAt: now(),
  };
}

/**
 * Reconcile the recorded proposal with what the forge says happened to it.
 *
 *   merged           → the work landed; clear the pointer and hold the marker.
 *   closed unmerged  → the work did NOT land; return its slices to the backlog and ROLL THE MARKER
 *                      BACK (FR-016b). Without this edge, abandoning a proposal leaves the marker
 *                      certifying work that never happened — a permanent, invisible gap.
 *   open             → nothing to do.
 */
export function reconcileProposal({ root = REPO_ROOT, record = null, forge, persist = true } = {}) {
  const runRecord = record ?? readRunRecord(root);
  if (!runRecord.proposal?.number) return { record: runRecord, action: 'none', persisted: false };

  const pull = forge.getPull(runRecord.proposal.number);
  if (!pull || pull.state === 'open') return { record: runRecord, action: 'still-open', persisted: false };

  const merged = Boolean(pull.merged);
  const next = {
    ...runRecord,
    proposal: null,
    backlog: merged
      ? runRecord.backlog
      : [...(runRecord.backlog ?? []), ...(runRecord.proposal.slices ?? [])],
    coveredCommit: merged ? runRecord.coveredCommit : (runRecord.proposal.markerBefore ?? null),
  };

  const persisted = persist ? writeRunRecord(root, next) : next;
  return { record: persisted, action: merged ? 'merged' : 'closed-unmerged', persisted: persist };
}

/**
 * The Forgejo REST client. Reads its token from the environment — never from an argument, so it cannot
 * reach a process listing or a log (FR-024).
 */
export function forgejoClient({ base = process.env.FORGE_API_BASE, owner, repo, token = process.env.FORGE_TOKEN } = {}) {
  if (!base || !owner || !repo || !token) throw new Error('the forge client needs FORGE_API_BASE, owner, repo and FORGE_TOKEN');
  const url = (suffix) => `${base.replace(/\/$/, '')}/repos/${owner}/${repo}${suffix}`;
  const headers = { Authorization: `token ${token}`, 'Content-Type': 'application/json' };
  const call = async (method, suffix, payload) => {
    const res = await fetch(url(suffix), { method, headers, body: payload ? JSON.stringify(payload) : undefined });
    if (!res.ok) throw new Error(`forge ${method} ${suffix} → ${res.status}`);
    return res.json();
  };
  return {
    createPull: ({ head, base: target, title, body }) => call('POST', '/pulls', { head, base: target, title, body }),
    listPulls: ({ state = 'open', limit = 50 } = {}) => call('GET', `/pulls?state=${state}&limit=${limit}`),
    getPull: (number) => call('GET', `/pulls/${number}`),
    updatePull: (number, { body, title }) => call('PATCH', `/pulls/${number}`, { body, title }),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// FR-012/FR-017 — one run, and what its outcome is called
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Plan, execute, verify, and classify — the whole run, in one place so that local and CI take the
 * identical path (FR-020).
 *
 * Outcome classification is the load-bearing part, and there is exactly one misclassification that
 * matters: **a credential, capacity or generator failure must never be reported as `nothing-to-do`**
 * (FR-017). That report would make the cheap path look reachable while the work silently never
 * happened, and would advance the marker over a range nothing had examined.
 */
export function runMaintenance({
  root = REPO_ROOT,
  bundleRoot = null,
  since = null,
  policy = null,
  invoke = undefined,
  credential = process.env.ANTHROPIC_API_KEY ?? null,
  requireCredential = true,
  pageBudget = PAGE_BUDGET,
  timeBudgetSeconds = TIME_BUDGET_SECONDS,
  maxSlices = null,
  dryRun = false,
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
} = {}) {
  const record = readRunRecord(root);
  const plan = computePlan({ root, bundleRoot, since, record, policy, pageBudget, now });

  if (plan.slices.length === 0) {
    // The free path, and the whole reason the run record exists: a run that finds nothing to document
    // advances the marker at no cost, so the next run over the same tree is free too (FR-012).
    // Deliberately checked BEFORE the credential: finding nothing to do genuinely needs no credential,
    // and failing here would make the cheap path depend on a secret it never uses.
    const persisted = dryRun ? record : writeRunRecord(root, {
      ...record,
      coveredCommit: plan.baseCommit,
      coveredAt: now(),
      lastOutcome: 'nothing-to-do',
      lastRunBudget: { pagesWritten: 0, elapsedSeconds: 0, stoppedAtBudget: false },
    });
    return { outcome: 'nothing-to-do', exitCode: 0, reason: null, plan, results: [], pagesWritten: 0, elapsedSeconds: 0, stoppedAtBudget: false, backlog: record.backlog ?? [], deferred: [], record: persisted, persisted: !dryRun };
  }

  if (requireCredential && !dryRun && !credential) {
    // Exit 2, and the record is left exactly as it was. Writing anything here would either certify a
    // range nothing examined or invent an outcome for a run that never started.
    return { outcome: 'failed', exitCode: 2, reason: 'missing-credential', plan, results: [], pagesWritten: 0, elapsedSeconds: 0, stoppedAtBudget: false, backlog: record.backlog ?? [], deferred: [], record, persisted: false };
  }

  const run = executeSlices({
    root,
    bundleRoot,
    slices: plan.slices,
    record,
    policy,
    ...(invoke === undefined ? {} : { invoke }),
    pageBudget,
    timeBudgetSeconds,
    maxSlices,
    dryRun,
    baseCommit: plan.baseCommit,
    now,
    clock,
  });

  return { ...run, reason: run.outcome === 'failed' ? 'slice-failed-verification' : null, plan };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// C6 — the run budget
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Two budgets, whichever is reached first, both DIRECTLY OBSERVED:
//   * pages — counted from files that actually appeared in the working tree, never from the
//     generator's account of its own output (FR-011b). Research R2: nothing constrains the generator
//     to the page list it was given, so a budget that trusted its self-report would inherit exactly
//     the false-green failure this feature exists to eliminate.
//   * wall-clock — measured by the run itself.
//
// Enforced BETWEEN slices, so a slice already under way is never interrupted. The overshoot is
// therefore bounded at one slice (≤8 pages, ≤~17 min — feature 043's measured worst case), giving a
// declared EFFECTIVE CEILING of ≤24 pages / ~37 minutes (FR-011a). The workflow's timeout-minutes: 45
// sits above that plus checkout and install overhead.
//
// The wall-clock budget bounds RUNNER OCCUPANCY (FR-011c) — there is one CI runner and a paid job
// must not squat on it. **NEITHER BUDGET IS A MONETARY BOUND** (FR-011d): OpenWiki emits no token or
// cost data (research R1), this repository has no cost measurements, and no requirement in this
// feature asserts a spend ceiling. Do not describe these as cost controls, and do not add one back.

export const PAGE_BUDGET = 16;

/**
 * Attempts per slice before it goes back to the backlog.
 *
 * The generator is NON-DETERMINISTIC — measured, not assumed: identical slice, identical message, 3
 * verified pages on one run and nothing on the next. Retrying is the response to a flaky dependency,
 * not a way of hiding one; every attempt is reported, and the run budget still bounds the total.
 */
export const ATTEMPTS_PER_SLICE = 3;
export const TIME_BUDGET_SECONDS = 20 * 60;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// FR-005/FR-006 — the verifier
// ════════════════════════════════════════════════════════════════════════════════════════════════

const OKF_GATE = join(REPO_ROOT, 'scripts', 'check-openwiki-okf.mjs');

/**
 * What the working tree says was written — the only trustworthy account of a run's output.
 *
 * `git status` is used rather than a directory walk because it sees writes ANYWHERE in the checkout,
 * which is what the policy guard needs: a generator that wrote into `docs/runbooks/` has exceeded its
 * scope, and a bundle-only walk would never notice (FR-026e).
 */
export function detectWrittenPaths(root = REPO_ROOT) {
  const r = spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git status failed in ${root}: ${(r.stderr ?? '').trim()}`);
  const paths = [];
  for (const line of r.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const body = line.slice(3);
    // A rename reports `old -> new`; the write is the destination.
    const path = body.includes(' -> ') ? body.split(' -> ')[1] : body;
    const clean = path.replace(/^"|"$/g, '');
    if (clean === STATE_FILE) continue; // our own bookkeeping, not the run's output
    paths.push(clean);
  }
  return paths.sort();
}

const sha = (file) => {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
};

/** Snapshot dirty paths and their content, so a file that was already dirty is not double-counted. */
export function snapshotTree(root = REPO_ROOT) {
  const paths = detectWrittenPaths(root);
  return new Map(paths.map((p) => [p, sha(join(root, p))]));
}

const isConceptPage = (relPath) => relPath.endsWith('.md') && !RESERVED_BUNDLE_FILES.has(basename(relPath));

/**
 * Judge a slice by what actually landed.
 *
 * Success requires ALL THREE, and the generator's exit status is not among them (contract C1):
 *   1. at least one CONCEPT page appeared or changed — an `index.md` refresh is not work, which is
 *      exactly what 043's false-green run produced;
 *   2. the bundle still passes the OKF conformance gate;
 *   3. every written path was permitted by openwiki/policy.yaml (FR-026e).
 */
export function verifySlice({ root = REPO_ROOT, bundleRoot = null, slice, policy = null, before = new Map(), actor = 'generator' } = {}) {
  const bundleDir = bundleRoot ?? join(root, DEFAULT_BUNDLE);
  const bundlePrefix = `${relative(root, bundleDir).split(sep).join('/')}/`;

  const after = snapshotTree(root);
  const written = [...after.keys()].filter((p) => !before.has(p) || before.get(p) !== after.get(p));

  const violations = [];

  const pagesWritten = written.filter((p) => p.startsWith(bundlePrefix) && isConceptPage(p));

  // The contract is the REQUESTED pages, not "some page appeared".
  //
  // Counting writes alone was both too weak and too strong. Too weak: a run that wrote three
  // unrelated pages while ignoring the request would have passed. Too strong: a refresh of a page
  // that is already accurate legitimately writes nothing, and calling that a failure is the mirror
  // image of the false green this gate exists to catch — measured, on a 1-page refresh slice that
  // needed no change and was reported as broken.
  //
  // Existence after the run is the checkable deliverable for creation; "nothing needed changing" is
  // an honest outcome for a refresh, reported distinguishably rather than as either success or failure.
  const missing = (slice.pages ?? []).filter((page) => !existsSync(join(bundleDir, slice.area, page)));
  if (missing.length > 0) {
    violations.push(
      `${missing.length} requested page(s) do not exist after the run: ${missing.map((m) => `${slice.area}/${m}`).join(', ')}. ` +
      'The generator produced nothing usable for them regardless of the status it exited with.',
    );
  }
  const noChange = missing.length === 0 && pagesWritten.length === 0;

  if (policy !== null) {
    for (const p of written) {
      const decision = mayWrite(policy, p, actor);
      if (!decision.allowed) {
        violations.push(`${p} — the run may not write here: ${decision.reason}${decision.entry ? ` (policy entry \`${decision.entry.glob}\`)` : ''}`);
      }
    }
  }

  const okf = spawnSync(process.execPath, [OKF_GATE, '--bundle', bundleDir], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (okf.status !== 0) {
    const detail = `${okf.stdout ?? ''}${okf.stderr ?? ''}`.trim().split('\n').filter((l) => l.includes('✗')).join('; ');
    violations.push(`the bundle is no longer conformant after this slice: ${detail || 'the OKF gate failed'}`);
  }

  return { ok: violations.length === 0, noChange, pagesWritten, writtenPaths: written, violations };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The executor
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The generator invocation, as an argv. ALWAYS through the Nx target, never the bare CLI: the target
 * carries the pinned model, the raised Node heap and `OPENWIKI_TELEMETRY_DISABLED=1`. A bare
 * `openwiki` call skips the telemetry opt-out and the heap, and OOMs (FR-021, FR-022).
 */
export const RUN_MESSAGE_ENV = 'WIKI_RUN_MESSAGE';

export function generatorCommand() {
  // `--output-style=stream` is not cosmetic. Nx BUFFERS a successful task's output and then prints
  // nothing, so a 7-minute paid run that wrote no pages left no trace of WHY — the generator's own
  // explanation of what it decided to do was captured and discarded. Streaming puts it in the run log,
  // and therefore in the CI failure digest, which is the whole point of feature 042's posture.
  return ['pnpm', 'nx', 'wiki-update', 'infrastructure-as-code', '--output-style=stream'];
}

/**
 * The run message travels in an ENVIRONMENT VARIABLE, not on the command line.
 *
 * MEASURED 2026-07-30, and it cost a paid run to find: passing it as `--args="<message>"` looked
 * correct — the nx process really did receive the whole quoted string as one argv element — but nx
 * STRIPS the quoting from the value before splicing it into the shell command, so the final process
 * was
 *
 *   /bin/sh -c openwiki code --update --print Work on exactly one area of the knowledge bundle ...
 *
 * i.e. a dozen bare words. The generator took the first token and ran effectively UNSCOPED, which for
 * a paid tool with no `--pages` flag is the worst available failure: it is free to rewrite anything.
 *
 * The Nx target now quotes `"$WIKI_RUN_MESSAGE"` inside its own command string, which nx does not
 * touch. A value inside double quotes is not re-parsed for `$` or backticks either, so the message
 * arrives byte-for-byte as one argument.
 */
export function generatorEnv(runMessage, env = process.env) {
  if (SHELL_UNSAFE.test(runMessage)) {
    throw new Error('run message contains a shell metacharacter — renderRunMessage must produce one safe line');
  }
  return { ...env, [RUN_MESSAGE_ENV]: runMessage };
}

function defaultInvoke(slice, { root }) {
  const message = slice.runMessage ?? renderRunMessage(slice);
  const [cmd, ...args] = generatorCommand();
  return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', encoding: 'utf8', env: generatorEnv(message) });
}

/**
 * Run slices in order, verifying each, stopping at CONSECUTIVE failures or at either budget.
 *
 * The original rule was "stop at the first failure", on the reasoning that a slice producing nothing
 * means something is wrong with the run and grinding through the rest spends paid capacity on the
 * same fault. That reasoning is right about a BROKEN RUN and wrong about a BAD SLICE — and the
 * difference showed up immediately on `main`: one unsatisfiable slice sat at the head of the backlog
 * and starved the legitimate work behind it, run after run, because execution never got past it.
 *
 * So: a failed slice is recorded and the next is attempted; `maxConsecutiveFailures` in a row stops
 * the run. Two consecutive failures distinguishes "this slice cannot be done" from "nothing can".
 */
export function executeSlices({
  root = REPO_ROOT,
  bundleRoot = null,
  slices = [],
  record = null,
  policy = null,
  invoke = defaultInvoke,
  pageBudget = PAGE_BUDGET,
  timeBudgetSeconds = TIME_BUDGET_SECONDS,
  maxSlices = null,
  maxConsecutiveFailures = 2,
  attemptsPerSlice = ATTEMPTS_PER_SLICE,
  dryRun = false,
  baseCommit = null,
  clock = () => Date.now(),
  now = () => new Date().toISOString(),
} = {}) {
  const runRecord = record ?? readRunRecord(root);
  const bundleDir = bundleRoot ?? join(root, DEFAULT_BUNDLE);
  const started = clock();
  const elapsed = () => Math.round((clock() - started) / 1000);

  const queue = maxSlices === null ? [...slices] : slices.slice(0, maxSlices);
  const carried = maxSlices === null ? [] : slices.slice(maxSlices);

  const results = [];
  const backlog = [...carried];
  // `deferred` is what the BUDGET stopped; `backlog` is everything carried forward, which also
  // includes a failed slice and anything --max-slices held back. Conflating them would report a
  // budget stop and a failure as the same state (SC-006a).
  const deferred = [...carried];
  let pagesWritten = 0;
  let stoppedAtBudget = false;
  let stoppedAtFailureLimit = false;
  let failed = false;
  let consecutive = 0;

  if (dryRun) {
    return {
      outcome: slices.length === 0 ? 'nothing-to-do' : 'dry-run',
      exitCode: 0,
      results: queue.map((s) => ({ slice: s, dryRun: true, command: generatorCommand(), runMessage: s.runMessage ?? renderRunMessage(s) })),
      pagesWritten: 0,
      elapsedSeconds: elapsed(),
      stoppedAtBudget: false,
      backlog: slices,
      deferred: [],
      persisted: false,
    };
  }

  for (const [i, slice] of queue.entries()) {
    // Budgets are checked BETWEEN slices, never inside one: interrupting a slice mid-generation would
    // leave a half-written area, which is a conformance failure rather than a saving. The overshoot is
    // therefore bounded at one slice — the declared effective ceiling in the header comment.
    if (i > 0 && (pagesWritten >= pageBudget || elapsed() >= timeBudgetSeconds)) {
      stoppedAtBudget = true;
      backlog.push(...queue.slice(i));
      deferred.push(...queue.slice(i));
      break;
    }

    // RETRY, because the generator is non-deterministic. Measured across ten runs of the feature-044
    // relocation: the SAME slice with the SAME message produced 3 verified pages on one run and
    // nothing on the next, roughly half the time each. That is not a bug to be found in this code —
    // it is a property of the dependency, and a maintenance loop that fails half the time gets
    // ignored, which makes the whole arrangement worthless.
    //
    // Two independent attempts at ~50% take a slice to ~75%; three to ~87%. Bounded by the same page
    // and wall-clock budgets as everything else, and every attempt is reported, so a slice that fails
    // repeatedly is still visible rather than buried under a retry.
    let verdict;
    let invocation;
    let attempts = 0;
    // Snapshotted ONCE, before the first attempt — the slice is judged against the state it started
    // from, not against the state its own previous attempt left behind.
    //
    // Re-snapshotting per attempt LAUNDERED A POLICY VIOLATION INTO A SUCCESS, and the existing tests
    // caught it immediately: attempt 1 wrote a forbidden path and failed; attempt 2 re-snapshotted,
    // so that write was now "pre-existing", the stub rewrote the same bytes, nothing new appeared —
    // and the slice passed. A retry must never be able to forgive what the previous attempt did.
    const before = snapshotTree(root);
    for (let attempt = 1; attempt <= attemptsPerSlice; attempt++) {
      attempts = attempt;
      try {
        invocation = invoke(slice, { root, bundleRoot: bundleDir, attempt });
      } catch (err) {
        // A thrown invocation is a real failure — but it is NOT `nothing-to-do` (FR-017).
        invocation = { error: err.message };
      }
      verdict = verifySlice({ root, bundleRoot: bundleDir, slice, policy, before });
      if (verdict.ok) break;
      if (attempt < attemptsPerSlice) {
        // Do not retry into a budget we have already spent.
        if (elapsed() >= timeBudgetSeconds) break;
        console.error(`[wiki-maintain] ${slice.area}/ attempt ${attempt} produced nothing — retrying (${attempt + 1}/${attemptsPerSlice}).`);
      }
    }

    results.push({ slice, ...verdict, attempts, invocationError: invocation?.error ?? null });

    if (!verdict.ok) {
      failed = true;
      consecutive += 1;
      backlog.push(slice);
      if (consecutive >= maxConsecutiveFailures) {
        // Not "this slice is bad" any more — something about the run is.
        stoppedAtFailureLimit = true;
        backlog.push(...queue.slice(i + 1));
        break;
      }
      continue;
    }
    consecutive = 0;
    pagesWritten += verdict.pagesWritten.length;
  }

  const outcome = failed ? 'failed' : slices.length === 0 ? 'nothing-to-do' : 'completed';

  // The marker advances on every outcome EXCEPT failure. A budget stop still advances, because the
  // remainder is in the backlog and therefore not lost; a failure must not, because the range it
  // covered was examined and NOT dealt with (data-model E3).
  const persistedRecord = writeRunRecord(root, {
    ...runRecord,
    coveredCommit: failed ? runRecord.coveredCommit : (baseCommit ?? runRecord.coveredCommit),
    coveredAt: failed ? runRecord.coveredAt : now(),
    lastOutcome: outcome,
    backlog,
    lastRunBudget: { pagesWritten, elapsedSeconds: elapsed(), stoppedAtBudget },
  });

  const exitCode = failed ? 1 : stoppedAtBudget || backlog.length > 0 ? 3 : 0;

  return { outcome, exitCode, results, pagesWritten, elapsedSeconds: elapsed(), stoppedAtBudget, stoppedAtFailureLimit, backlog, deferred, record: persistedRecord, persisted: true };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CLI
// ════════════════════════════════════════════════════════════════════════════════════════════════

export function parseArgs(argv) {
  const opts = {
    mode: null,
    since: null,
    json: false,
    dryRun: false,
    maxSlices: null,
    pageBudget: PAGE_BUDGET,
    timeBudgetSeconds: TIME_BUDGET_SECONDS,
    propose: false,
    dispatched: false,
  };
  const wants = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} requires a value`);
    return v;
  };
  const setMode = (m) => {
    if (opts.mode !== null && opts.mode !== m) throw new Error(`--${opts.mode} and --${m} are mutually exclusive`);
    opts.mode = m;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') setMode('plan');
    else if (a === '--execute') setMode('execute');
    else if (a === '--selftest') setMode('selftest');
    else if (a === '--should-wait') setMode('should-wait');
    else if (a === '--propose') opts.propose = true;
    else if (a === '--dispatched') opts.dispatched = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--since') opts.since = wants(++i, '--since');
    else if (a.startsWith('--since=')) opts.since = a.slice('--since='.length);
    else if (a === '--max-slices') opts.maxSlices = Number(wants(++i, '--max-slices'));
    else if (a.startsWith('--max-slices=')) opts.maxSlices = Number(a.slice('--max-slices='.length));
    else if (a === '--page-budget') opts.pageBudget = Number(wants(++i, '--page-budget'));
    else if (a.startsWith('--page-budget=')) opts.pageBudget = Number(a.slice('--page-budget='.length));
    else if (a === '--time-budget') opts.timeBudgetSeconds = Number(wants(++i, '--time-budget'));
    else if (a.startsWith('--time-budget=')) opts.timeBudgetSeconds = Number(a.slice('--time-budget='.length));
    else throw new Error(`unknown argument: ${a}`);
  }

  if (opts.mode === null) throw new Error('one of --plan, --execute, --should-wait or --selftest is required');
  for (const [k, v] of Object.entries({ maxSlices: opts.maxSlices, pageBudget: opts.pageBudget, timeBudgetSeconds: opts.timeBudgetSeconds })) {
    if (v !== null && (!Number.isFinite(v) || v <= 0)) throw new Error(`${k} must be a positive number`);
  }
  return opts;
}

const USAGE = [
  'Usage:',
  '  node scripts/wiki-maintain.mjs --plan    [--since <ref>] [--json]',
  '  node scripts/wiki-maintain.mjs --execute [--since <ref>] [--max-slices <n>] [--dry-run] [--json]',
  '  node scripts/wiki-maintain.mjs --should-wait [--dispatched]   # debounce decision, offline',
  '  node scripts/wiki-maintain.mjs --selftest',
  '',
  'Invoke through Nx: `pnpm nx wiki-plan infrastructure-as-code` / `pnpm nx wiki-maintain infrastructure-as-code`.',
].join('\n');

function reportPlan(plan, { json }) {
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const since = plan.sinceResolved === false
    ? `${plan.sinceCommit.slice(0, 8)} NOT IN THIS CHECKOUT — full sweep`
    : plan.sinceCommit ? plan.sinceCommit.slice(0, 8) : 'never covered — full sweep';
  console.log(`[wiki-maintain] plan at ${plan.baseCommit.slice(0, 8)} (since ${since})`);
  console.log(`[wiki-maintain] ${plan.changedPaths.length} documentation path(s) changed in range`);
  if (plan.slices.length === 0) {
    console.log('[wiki-maintain] 0 slices — nothing to document.');
    return;
  }
  console.log(`[wiki-maintain] ${plan.slices.length} slice(s), ${plan.plannedPages} page(s) this run:`);
  for (const [i, s] of plan.slices.entries()) {
    console.log(`  ${i + 1}. ${s.area}/ (${s.areaExists ? 'exists' : 'NEW area'}) — ${s.pages.length} page(s): ${s.pages.join(', ')}`);
    console.log(`     why: ${s.reason}`);
  }
  if (plan.deferred.length > 0) {
    console.log(`[wiki-maintain] ${plan.deferred.length} slice(s) deferred beyond the ${PAGE_BUDGET}-page budget, carried forward:`);
    for (const s of plan.deferred) console.log(`  - ${s.area}/ — ${s.pages.join(', ')}`);
  }
  if (plan.missingEventDocuments?.length > 0) {
    console.log(`[wiki-maintain] ${plan.missingEventDocuments.length} event-driven document(s) may be missing (reported, not blocking):`);
    for (const f of plan.missingEventDocuments) console.log(`  - ${f.path} — ${f.reason}`);
  }
  if (plan.dropped?.length > 0) {
    console.log(`[wiki-maintain] ${plan.dropped.length} carried-forward page(s) dropped — the policy no longer covers their source:`);
    for (const d of plan.dropped) console.log(`  - ${d}`);
  }
  if (plan.uncovered.length > 0) {
    console.log(`[wiki-maintain] ${plan.uncovered.length} changed source(s) no concept covers yet:`);
    for (const p of plan.uncovered) console.log(`  - ${p}`);
  }
}

// ── FR-008: --selftest ──────────────────────────────────────────────────────────
// Proves the planner and — above all — the VERIFIER still detect their cases, against T001's
// fixtures and a deliberately sabotaged generator. Offline and keyless: a check on the machinery that
// needed the paid machinery to run would be useless exactly when it matters.

function selftest() {
  const fails = [];
  const check = (name, cond, detail = '') => {
    if (!cond) fails.push(`${name}${detail ? `: ${detail}` : ''}`);
  };

  const fixtures = join(REPO_ROOT, 'scripts', '__tests__', 'fixtures', 'wiki-maintain');

  // ── planner ───────────────────────────────────────────────────────────────────
  const mixed = planSlices({
    bundleRoot: join(fixtures, 'new-and-existing-areas'),
    changedPaths: [],
    backlog: [
      { area: 'gotchas', pages: ['musl-vendored-openssl.md'], areaExists: false, reason: 'x' },
      { area: 'runbooks', pages: ['brand-new.md'], areaExists: true, reason: 'x' },
    ],
  });
  check('planner splits areas', mixed.length === 2, `got ${mixed.length} slice(s)`);
  check('planner derives areaExists from the tree',
    mixed.find((s) => s.area === 'gotchas')?.areaExists === true && mixed.find((s) => s.area === 'runbooks')?.areaExists === false,
    'a caller-supplied areaExists must be ignored');

  const big = planSlices({
    bundleRoot: join(fixtures, 'new-and-existing-areas'),
    changedPaths: [],
    backlog: [{ area: 'gotchas', pages: Array.from({ length: 20 }, (_, i) => `p${i}.md`), reason: 'x' }],
  });
  check('planner caps slices at 8 pages', big.every((s) => s.pages.length <= MAX_PAGES_PER_SLICE),
    `sizes ${big.map((s) => s.pages.length).join(',')}`);

  // ── run message ───────────────────────────────────────────────────────────────
  const message = renderRunMessage({ area: 'gotchas', pages: ['a.md', 'b.md'], areaExists: true, reason: 'x' });
  check('run message names every page', message.includes('a.md') && message.includes('b.md'));
  check('run message survives shell parsing', !/["`$\\\n\r]/.test(message), JSON.stringify(message.slice(0, 80)));

  // ── verifier: the sabotaged generator ─────────────────────────────────────────
  // A generator that exits 0 having written nothing. This is the exact false green feature 043
  // measured, and a clean verdict here means the detector is broken.
  const scratch = mkdtempSync(join(tmpdir(), 'wiki-selftest-'));
  try {
    cpSync(join(fixtures, 'conformant-bundle'), join(scratch, DEFAULT_BUNDLE), { recursive: true });
    for (const args of [['init', '-q'], ['config', 'user.email', 'selftest@example.invalid'], ['config', 'user.name', 'selftest'], ['add', '-A'], ['commit', '-qm', 'baseline']]) {
      spawnSync('git', args, { cwd: scratch, encoding: 'utf8' });
    }

    const sabotaged = executeSlices({
      root: scratch,
      slices: [{ area: 'invariants', pages: ['nothing.md'], areaExists: true, reason: 'selftest' }],
      record: { ...readRunRecord(scratch), coveredCommit: 'unchanged-marker' },
      invoke: () => ({ status: 0 }),
    });
    check('verifier fails a zero-page slice', sabotaged.outcome === 'failed', `got ${sabotaged.outcome}`);
    check('verifier exits 1 on failure', sabotaged.exitCode === 1, `got ${sabotaged.exitCode}`);
    check('failed slice returns to the backlog', sabotaged.backlog.length === 1);
    check('marker does not advance on failure', readRunRecord(scratch).coveredCommit === 'unchanged-marker');

    // ...and a slice that genuinely writes its page verifies clean, so the detector is not simply
    // failing everything.
    const honest = executeSlices({
      root: scratch,
      slices: [{ area: 'invariants', pages: ['selftest-page.md'], areaExists: true, reason: 'selftest' }],
      record: readRunRecord(scratch),
      baseCommit: 'advanced-marker',
      invoke: () => {
        writeFileSync(join(scratch, DEFAULT_BUNDLE, 'invariants', 'selftest-page.md'),
          '---\ntype: Convention\ntitle: Selftest\ndescription: Written by --selftest.\n---\nBody.\n');
        writeFileSync(join(scratch, DEFAULT_BUNDLE, 'invariants', 'index.md'),
          '# Invariants\n- [Auth Chain](auth-chain.md)\n- [Selftest](selftest-page.md)\n');
        return { status: 0 };
      },
    });
    check('verifier passes a slice that produced pages', honest.outcome === 'completed',
      `got ${honest.outcome}: ${honest.results.flatMap((r) => r.violations ?? []).join('; ')}`);
    check('marker advances on success', readRunRecord(scratch).coveredCommit === 'advanced-marker');

    // ── verifier: non-conformant output ─────────────────────────────────────────
    const broken = executeSlices({
      root: scratch,
      slices: [{ area: 'invariants', pages: ['broken.md'], areaExists: true, reason: 'selftest' }],
      record: readRunRecord(scratch),
      invoke: () => {
        writeFileSync(join(scratch, DEFAULT_BUNDLE, 'invariants', 'broken.md'), '---\ntitle: no type\n---\nBody.\n');
        return { status: 0 };
      },
    });
    check('verifier fails a slice that broke conformance', broken.outcome === 'failed', `got ${broken.outcome}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // ── policy ────────────────────────────────────────────────────────────────────
  try {
    const policy = loadPolicy(REPO_ROOT);
    check('policy permits the generator inside the bundle', mayWrite(policy, 'openwiki/gotchas/x.md', 'generator').allowed);
    check('policy forbids the generator outside the bundle', !mayWrite(policy, 'docs/runbooks/local-dev.md', 'generator').allowed);
    check('policy forbids writing the protection manifest', !mayWrite(policy, 'openwiki/protected.yaml', 'generator').allowed);
    check('policy forbids writing the generation brief', !mayWrite(policy, 'openwiki/INSTRUCTIONS.md', 'generator').allowed);
  } catch (err) {
    fails.push(`policy did not load: ${err.message}`);
  }

  if (fails.length > 0) {
    console.error('✗ wiki-maintain --selftest FAILED:\n  ' + fails.join('\n  '));
    return 1;
  }
  console.log('✓ wiki-maintain --selftest passed (planner bounds and area derivation, shell-safe run message, zero-page detection, conformance regression, marker advance/hold, policy write scope)');
  return 0;
}

/** What a reviewer sees. States what was written, what is outstanding, and what may be missing. */
export function proposalBody(plan, result) {
  const lines = [
    'Automated OpenWiki knowledge-bundle maintenance.',
    '',
    `Covering documentation changes since \`${plan.sinceCommit ? plan.sinceCommit.slice(0, 12) : 'the first commit'}\` up to \`${plan.baseCommit.slice(0, 12)}\`.`,
    '',
    `**Outcome**: \`${result.outcome}\` — ${result.pagesWritten} page(s) written in ${result.elapsedSeconds}s.`,
    '',
    'Every slice below was verified by the pages that actually appeared in the working tree and by the',
    'OKF conformance gate — never by the generator\'s exit status.',
    '',
  ];
  for (const r of result.results) {
    lines.push(`- ${r.ok ? '✅' : '✗'} \`${r.slice.area}/\` — ${(r.pagesWritten ?? []).length} page(s): ${r.slice.pages.join(', ')}`);
    for (const v of r.violations ?? []) lines.push(`  - ${v}`);
  }
  if (result.stoppedAtFailureLimit) {
    console.error(`[wiki-maintain] stopped after ${result.results.filter((r) => !r.ok).length} consecutive slice failures — this looks like a broken run rather than a bad slice.`);
  }
  if (result.stoppedAtBudget) {
    lines.push('', `Stopped at the run budget with ${result.deferred.length} slice(s) outstanding. That is exit 3 — **not** a failure; the remainder is in the backlog and the next run picks it up.`);
  }
  if (plan.missingEventDocuments?.length > 0) {
    lines.push('', '**Possibly missing event-driven documents** (reported, not blocking):');
    for (const f of plan.missingEventDocuments) lines.push(`- \`${f.path}\` — ${f.reason}`);
  }
  if (plan.uncovered?.length > 0) {
    lines.push('', 'Changed sources no concept covers yet:');
    for (const p of plan.uncovered) lines.push(`- \`${p}\``);
  }
  lines.push('', 'Review this like any hand-authored documentation change. A commit you push onto this branch survives every subsequent update — the branch is rebased and appended to, never force-replaced.');
  return lines.join('\n');
}

// The Forgejo client is async (fetch); the lifecycle functions are otherwise synchronous so they can
// be unit-tested with an in-memory forge. These wrappers await the client without making the whole
// lifecycle async for every caller.
async function reconcileProposalAsync({ root, forge, branch = PROPOSAL_BRANCH }) {
  const record = readRunRecord(root);
  if (!record.proposal?.number) {
    // The record may simply have been lost. If a proposal for our branch is open, adopt it so that a
    // later close-unmerged still returns its work to the backlog.
    const open = await forge.listPulls({ state: 'open' }).catch(() => []);
    const found = open.find((p) => p.head?.ref === branch);
    if (!found) return { record, action: 'none' };
    const adopted = writeRunRecord(root, { ...record, proposal: { branch, number: found.number, markerBefore: record.coveredCommit ?? null, slices: [] } });
    console.log(`[wiki-maintain] adopted open proposal #${found.number} into the run record.`);
    return { record: adopted, action: 'adopted' };
  }
  const pull = await forge.getPull(record.proposal.number);
  return reconcileProposal({ root, record, forge: { getPull: () => pull } });
}

async function publishProposalAsync({ root, forge, branch = PROPOSAL_BRANCH, ...rest }) {
  const record = readRunRecord(root);

  let existing = record.proposal?.number ? await forge.getPull(record.proposal.number).catch(() => null) : null;
  if (!existing || existing.state !== 'open') {
    // The record did not know about it. Ask the forge, which does.
    const open = await forge.listPulls({ state: 'open' }).catch(() => []);
    existing = open.find((p) => p.head?.ref === branch) ?? null;
    if (existing) console.log(`[wiki-maintain] adopting existing open proposal #${existing.number} — the run record had lost the pointer to it.`);
  }

  const created = [];
  const sync = {
    getPull: () => existing,
    listPulls: () => (existing ? [existing] : []),
    createPull: (args) => { created.push(args); return { number: -1 }; },
    updatePull: (number) => ({ number }),
  };
  const proposal = publishProposal({ root, record, forge: sync, branch, ...rest });

  if (created.length > 0) {
    try {
      const pull = await forge.createPull(created[0]);
      return { ...proposal, number: pull.number };
    } catch (err) {
      // 409 = one already exists for this head. A race between the look-up above and this call, or a
      // forge that knows something the list did not. Adopt it rather than failing the whole run over
      // a proposal that is already there.
      if (!/→ 409/.test(err.message)) throw err;
      const open = await forge.listPulls({ state: 'open' }).catch(() => []);
      const found = open.find((p) => p.head?.ref === branch);
      if (!found) throw err;
      console.log(`[wiki-maintain] a proposal for ${branch} already existed (#${found.number}) — updating it instead of opening another.`);
      await forge.updatePull(found.number, { body: rest.body });
      return { ...proposal, number: found.number };
    }
  }
  await forge.updatePull(existing.number, { body: rest.body });
  return { ...proposal, number: existing.number };
}

function reportRun(result, { json }) {
  if (json) {
    console.log(JSON.stringify({
      outcome: result.outcome,
      exitCode: result.exitCode,
      pagesWritten: result.pagesWritten,
      elapsedSeconds: result.elapsedSeconds,
      stoppedAtBudget: result.stoppedAtBudget,
      deferred: result.deferred,
      backlog: result.backlog,
      results: result.results.map((r) => ({
        area: r.slice.area,
        pages: r.slice.pages,
        ok: r.ok ?? null,
        pagesWritten: r.pagesWritten ?? [],
        violations: r.violations ?? [],
        command: r.command ?? null,
      })),
    }, null, 2));
    return;
  }

  if (result.outcome === 'dry-run') {
    console.log('[wiki-maintain] dry run — nothing was invoked. Per slice, the command would be:');
    for (const r of result.results) {
      console.log(`  ${r.slice.area}/ → ${r.command.join(' ')}`);
      console.log(`     ${RUN_MESSAGE_ENV}=${r.runMessage}`);
    }
    return;
  }

  for (const r of result.results) {
    const tries = r.attempts > 1 ? ` after ${r.attempts} attempts` : '';
    if (r.ok && r.noChange) console.log(`[wiki-maintain] ✅ ${r.slice.area}/ — every requested page is present and nothing needed changing (0 written)${tries}`);
    else if (r.ok) console.log(`[wiki-maintain] ✅ ${r.slice.area}/ — ${r.pagesWritten.length} page(s) written and verified${tries}`);
    else {
      console.error(`[wiki-maintain] ✗ ${r.slice.area}/ — slice FAILED verification after ${r.attempts} attempt(s):`);
      for (const v of r.violations) console.error(`    ${v}`);
      if (r.invocationError) console.error(`    invocation error: ${r.invocationError}`);
    }
  }

  console.log(`[wiki-maintain] outcome=${result.outcome} pages=${result.pagesWritten} elapsed=${result.elapsedSeconds}s`);
  if (result.stoppedAtBudget) {
    console.log(`[wiki-maintain] stopped at the run budget with ${result.deferred.length} slice(s) outstanding — exit 3, NOT a failure.`);
  }
  if (result.backlog.length > 0) {
    console.log(`[wiki-maintain] ${result.backlog.length} slice(s) carried forward in ${STATE_FILE}:`);
    for (const s of result.backlog) console.log(`  - ${s.area}/ — ${s.pages.join(', ')}`);
  }
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`[wiki-maintain] ${err.message}`);
    console.error(USAGE);
    return 2;
  }

  let policy;
  try {
    policy = loadPolicy(REPO_ROOT);
  } catch (err) {
    console.error(`[wiki-maintain] ${err.message}`);
    return 2;
  }

  if (opts.mode === 'should-wait') {
    // The debounce decision, offline and free. Printed as `wait=<bool>` on stdout so a shell step can
    // read it directly; the reasoning goes to stderr, where it is visible without being parsed.
    const age = oldestUncoveredAgeSeconds({ root: REPO_ROOT });
    const decision = shouldDeferMaintenance({ oldestUncoveredAgeSeconds: age, dispatched: opts.dispatched });
    console.log(`wait=${decision.defer}`);
    console.error(`[wiki-maintain] ${decision.reason}`);
    return 0;
  }

  if (opts.mode === 'plan') {
    let plan;
    try {
      plan = computePlan({ since: opts.since, policy, pageBudget: opts.pageBudget });
    } catch (err) {
      console.error(`[wiki-maintain] ${err.message}`);
      return 2;
    }
    reportPlan(plan, opts);
    return 0;
  }

  if (opts.mode === 'execute') {
    // A credential failure is exit 2 and is reported as such. Classifying it as `nothing-to-do`
    // would be the worst available lie: the cheap path would look reachable while the work silently
    // never happened, and the marker would advance over a range nothing examined (FR-017).
    if (!opts.dryRun && !process.env.ANTHROPIC_API_KEY) {
      console.error('[wiki-maintain] ANTHROPIC_API_KEY is not set — --execute needs the model credential.');
      console.error('[wiki-maintain] This is a missing credential, NOT "nothing to do". Run --plan for the free path.');
      return 2;
    }

    let plan;
    try {
      plan = computePlan({ since: opts.since, policy, pageBudget: opts.pageBudget });
    } catch (err) {
      console.error(`[wiki-maintain] ${err.message}`);
      return 2;
    }

    if (plan.slices.length === 0) {
      // The whole point of the run record: a run that finds nothing to document advances the marker
      // and costs nothing, so the next run over the same tree is free too (FR-012).
      //
      // A DRY RUN persists nothing, here as everywhere. This branch used to advance the marker even
      // under --dry-run, which meant asking "what would this do?" silently certified the range as
      // covered — the next real run would then find nothing and skip work that was never done.
      if (opts.dryRun) {
        console.log('[wiki-maintain] nothing to document — dry run, so the marker was NOT advanced.');
        return 0;
      }
      const record = readRunRecord(REPO_ROOT);
      writeRunRecord(REPO_ROOT, {
        ...record,
        coveredCommit: plan.baseCommit,
        coveredAt: new Date().toISOString(),
        lastOutcome: 'nothing-to-do',
        lastRunBudget: { pagesWritten: 0, elapsedSeconds: 0, stoppedAtBudget: false },
      });
      console.log('[wiki-maintain] nothing to document — marker advanced, no model invoked.');
      if (opts.json) console.log(JSON.stringify({ outcome: 'nothing-to-do', pagesWritten: 0, plan }, null, 2));
      return 0;
    }

    reportPlan(plan, { json: false });

    // Reconcile FIRST: if the previous proposal was closed unmerged, its work has to be back in the
    // backlog before this run plans around it, and the marker has to have rolled back (FR-016b).
    let forge = null;
    if (opts.propose) {
      try {
        forge = forgejoClient({ owner: process.env.FORGE_OWNER, repo: process.env.FORGE_REPO });
      } catch (err) {
        console.error(`[wiki-maintain] ${err.message}`);
        return 2;
      }
      const reconciled = await reconcileProposalAsync({ root: REPO_ROOT, forge });
      if (reconciled.action !== 'none' && reconciled.action !== 'still-open') {
        console.log(`[wiki-maintain] previous proposal ${reconciled.action} — record reconciled.`);
      }
      prepareProposalBranch({ root: REPO_ROOT, baseBranch: process.env.FORGE_BASE_BRANCH ?? 'main' });
    }

    const result = executeSlices({
      root: REPO_ROOT,
      slices: plan.slices,
      policy,
      pageBudget: opts.pageBudget,
      timeBudgetSeconds: opts.timeBudgetSeconds,
      maxSlices: opts.maxSlices,
      dryRun: opts.dryRun,
      baseCommit: plan.baseCommit,
    });

    reportRun(result, opts);

    if (opts.propose && result.pagesWritten > 0) {
      const proposal = await publishProposalAsync({
        root: REPO_ROOT,
        forge,
        baseBranch: process.env.FORGE_BASE_BRANCH ?? 'main',
        body: proposalBody(plan, result),
        slices: result.results.filter((r) => r.ok).map((r) => r.slice),
        remote: process.env.FORGE_REMOTE ?? 'origin',
        returnTo: process.env.FORGE_BASE_BRANCH ?? 'main',
      });
      const record = readRunRecord(REPO_ROOT);
      writeRunRecord(REPO_ROOT, { ...record, proposal });
      console.log(`[wiki-maintain] proposal #${proposal.number} on ${proposal.branch} — awaiting HUMAN review. Never auto-merged.`);
    }

    return result.exitCode;
  }

  return selftest();
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(await main(process.argv.slice(2)));

