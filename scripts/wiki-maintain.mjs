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
  maxPagesPerSlice = MAX_PAGES_PER_SLICE,
} = {}) {
  const { concepts, areas } = readBundle(bundleRoot);

  // area → Map(page → reason). A Map keeps insertion order deterministic and dedupes by page.
  const wanted = new Map();
  const want = (area, page, reason) => {
    if (!wanted.has(area)) wanted.set(area, new Map());
    const pages = wanted.get(area);
    if (!pages.has(page)) pages.set(page, reason);
  };

  // Carried-forward work first: a backlog that keeps losing to fresh changes never drains.
  for (const slice of backlog) {
    if (!slice || typeof slice.area !== 'string' || !Array.isArray(slice.pages)) continue;
    for (const page of slice.pages) want(slice.area, page, slice.reason ?? 'carried forward');
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

  const slices = [];
  for (const area of ordered) {
    const pages = [...wanted.get(area).keys()];
    const reasons = wanted.get(area);
    for (let i = 0; i < pages.length; i += maxPagesPerSlice) {
      const chunk = pages.slice(i, i + maxPagesPerSlice);
      slices.push({
        area,
        pages: chunk,
        // Derived from the tree, NEVER from the caller: a stale backlog entry claiming an area exists
        // would have the run extend a directory that is not there.
        areaExists: areas.has(area),
        reason: [...new Set(chunk.map((p) => reasons.get(p)))].join('; '),
      });
    }
  }

  slices.uncovered = uncovered;
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
  const { area, pages, areaExists } = slice;
  const list = pages.map((p) => `${area}/${p}`).join(', ');
  const scope = areaExists
    ? `The ${area} directory already exists, so update or add ONLY those pages and leave every other page in it untouched.`
    : `The ${area} directory does not exist yet, so create it, write its index.md, and write ONLY those pages.`;

  const message = [
    `Work on exactly one area of the knowledge bundle this run: ${area}.`,
    `Write or refresh exactly these pages and no others: ${list}.`,
    scope,
    'Do not touch any other directory of the bundle, and do not write outside the bundle at all.',
    'Follow openwiki/INSTRUCTIONS.md: a distilled summary plus the load-bearing gotchas, citing the authoritative source in a resource field where one exists, and NO resource field on a page that is authoritative in its own right.',
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

/**
 * Paths changed since `sinceCommit`. A null marker means "never covered", which is a full sweep
 * rather than an empty one — a first run must be able to see the whole tree.
 */
export function changedSince(root, sinceCommit) {
  if (!sinceCommit) return git(['ls-files'], root).split('\n').filter(Boolean).filter(isDocPath);
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

  const slices = planSlices({
    bundleRoot: bundleRoot ?? join(root, DEFAULT_BUNDLE),
    changedPaths,
    backlog: runRecord.backlog ?? [],
    policy,
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
    changedPaths: policy === null ? changedPaths : changedPaths.filter((p) => isCoverageTarget(policy, p)),
    slices: withMessages,
    deferred: deferred.map((s) => ({ ...s, runMessage: renderRunMessage(s) })),
    plannedPages: pages,
    uncovered: slices.uncovered ?? [],
  };
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
  if (pagesWritten.length === 0) {
    violations.push(
      `no page was written for slice \`${slice.area}\` — zero concept pages appeared in the working tree. ` +
      'The generator produced nothing usable regardless of the status it exited with.',
    );
  }

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

  return { ok: violations.length === 0, pagesWritten, writtenPaths: written, violations };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The executor
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The generator invocation, as an argv. ALWAYS through the Nx target, never the bare CLI: the target
 * carries the pinned model, the raised Node heap and `OPENWIKI_TELEMETRY_DISABLED=1`. A bare
 * `openwiki` call skips the telemetry opt-out and the heap, and OOMs (FR-021, FR-022).
 */
export function generatorCommand(runMessage) {
  if (SHELL_UNSAFE.test(runMessage)) {
    throw new Error('run message contains a shell metacharacter — renderRunMessage must produce one safe line');
  }
  // The double quotes are part of the VALUE on purpose: nx appends `--args`'s value to a shell
  // command line without quoting it, so the quoting has to travel inside the value or the message
  // arrives as a dozen separate arguments and the generator scopes itself to the first word.
  return ['pnpm', 'nx', 'wiki-update', 'infrastructure-as-code', `--args="${runMessage}"`];
}

function defaultInvoke(slice, { root }) {
  const [cmd, ...args] = generatorCommand(slice.runMessage ?? renderRunMessage(slice));
  return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', encoding: 'utf8' });
}

/**
 * Run slices in order, verifying each, stopping at the first failure or at either budget.
 *
 * Stopping at the FIRST failed slice is deliberate. A slice that produced nothing means something is
 * wrong with the run — the credential, the tool, the instructions — and grinding through the rest of
 * the plan spends paid capacity on the same fault repeatedly. The unattempted slices go to the
 * backlog, so nothing is lost.
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
  let failed = false;

  if (dryRun) {
    return {
      outcome: slices.length === 0 ? 'nothing-to-do' : 'dry-run',
      exitCode: 0,
      results: queue.map((s) => ({ slice: s, dryRun: true, command: generatorCommand(s.runMessage ?? renderRunMessage(s)) })),
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

    const before = snapshotTree(root);
    let invocation;
    try {
      invocation = invoke(slice, { root, bundleRoot: bundleDir });
    } catch (err) {
      // A thrown invocation is a real failure — but it is NOT `nothing-to-do` (FR-017).
      invocation = { error: err.message };
    }

    const verdict = verifySlice({ root, bundleRoot: bundleDir, slice, policy, before });
    results.push({ slice, ...verdict, invocationError: invocation?.error ?? null });

    if (!verdict.ok) {
      failed = true;
      backlog.push(slice, ...queue.slice(i + 1));
      break;
    }
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

  return { outcome, exitCode, results, pagesWritten, elapsedSeconds: elapsed(), stoppedAtBudget, backlog, deferred, record: persistedRecord, persisted: true };
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

  if (opts.mode === null) throw new Error('one of --plan, --execute or --selftest is required');
  for (const [k, v] of Object.entries({ maxSlices: opts.maxSlices, pageBudget: opts.pageBudget, timeBudgetSeconds: opts.timeBudgetSeconds })) {
    if (v !== null && (!Number.isFinite(v) || v <= 0)) throw new Error(`${k} must be a positive number`);
  }
  return opts;
}

const USAGE = [
  'Usage:',
  '  node scripts/wiki-maintain.mjs --plan    [--since <ref>] [--json]',
  '  node scripts/wiki-maintain.mjs --execute [--since <ref>] [--max-slices <n>] [--dry-run] [--json]',
  '  node scripts/wiki-maintain.mjs --selftest',
  '',
  'Invoke through Nx: `pnpm nx wiki-plan infrastructure-as-code` / `pnpm nx wiki-maintain infrastructure-as-code`.',
].join('\n');

function reportPlan(plan, { json }) {
  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const since = plan.sinceCommit ? plan.sinceCommit.slice(0, 8) : 'never covered — full sweep';
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
    }
    return;
  }

  for (const r of result.results) {
    if (r.ok) console.log(`[wiki-maintain] ✅ ${r.slice.area}/ — ${r.pagesWritten.length} page(s) written and verified`);
    else {
      console.error(`[wiki-maintain] ✗ ${r.slice.area}/ — slice FAILED verification:`);
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
    return result.exitCode;
  }

  return selftest();
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(await main(process.argv.slice(2)));

