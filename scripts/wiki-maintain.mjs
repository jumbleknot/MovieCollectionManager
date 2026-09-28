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
import { normalizeLinks } from './openwiki-links.mjs';
import { conceptStamp } from './openwiki-stamp.mjs';
import { WIKI_PROVIDERS, resolveWikiProvider } from './wiki-provider.mjs';
import { summarizeUsage, sumUsage, NOT_CAPTURED } from './wiki-usage.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Re-exported so a consumer needs one import, and so the run and the gate provably share one reader.
export { loadPolicy, resolvePolicy, mayWrite, isCoverageTarget } from './openwiki-policy.mjs';

// The run record lives beside the bundle it describes, and is COMMITTED: runners are ephemeral, and
// FR-012 requires the marker to advance even on a run that creates no proposal.
export const STATE_FILE = 'openwiki/.maintenance-state.json';

/**
 * Every environment variable this script will accept an Anthropic credential from, in precedence
 * order.
 *
 * EXPORTED because the test suite has to be able to construct the ABSENCE of a credential, and
 * re-listing these names there is what item #209 was: the list said `ANTHROPIC_API_KEY` alone, the
 * `MCM_`-prefixed name was added here and never mirrored, and from then on every credential-absence
 * test passed a credential to the child. It failed in every sanctioned environment — CLAUDE.md
 * carries the key under the `MCM_` name on the host, in the Docker Desktop dev container and in the
 * Sandbox VM — and, because `--execute` then skipped its own guard and ran the real path, the suite
 * also rewrote the TRACKED state file on every run.
 *
 * Read this constant rather than repeating the names, so the next addition cannot desynchronise.
 */
//
// Feature 078: the generator can run on more than one provider, so this is now EVERY provider's
// accepted names, derived from the provider table rather than re-listed (the same lesson, one level
// up). The Anthropic pair stays first and unchanged.
export const CREDENTIAL_ENV_NAMES = Object.freeze(
  [...new Set(Object.values(WIKI_PROVIDERS).flatMap((row) => row.credential.accepted))],
);

/**
 * The credential for the provider this run will actually use (MCM_WIKI_PROVIDER), from the first of
 * that provider's names that carries one — or null. A key for a DIFFERENT provider does not count.
 * A malformed selector throws, and is reported by the caller: it is never read as "no credential".
 */
export const credentialFromEnv = (env = process.env) =>
  resolveWikiProvider(env).credential.accepted.map((name) => env[name]).find(Boolean) ?? null;

/**
 * One minimal call with the resolved provider/model/tier, before any paid slice (078 FR-005). Spawned
 * rather than awaited because the orchestrator is synchronous; the launcher owns the provider logic.
 */
/**
 * The one preflight gate, shared by runMaintenance and the CLI's --execute path (which drives
 * executeSlices itself — a gate in only one of them would not run in CI). Dry runs and a
 * stubbed generator (preflight: null) pass; a failed check is returned, never thrown.
 */
export function preflightGate({ dryRun = false, preflight = defaultPreflight, root = REPO_ROOT } = {}) {
  if (dryRun || !preflight) return { ok: true, detail: 'skipped' };
  return preflight({ root });
}

export function defaultPreflight({ root = REPO_ROOT } = {}) {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'wiki-generate.mjs'), '--preflight'], {
    cwd: root, encoding: 'utf8', env: process.env,
  });
  const detail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').pop() ?? '';
  return { ok: r.status === 0, detail };
}

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

/**
 * Pages per GENERATOR INVOCATION, across areas (feature 078, US2).
 *
 * Every invocation pays a fixed planning pass whatever its scope — ~$0.33 on Sonnet, 83% of a one-page
 * run, because openwiki's planner explores the repository before planning (research R5). Slices are
 * per area, so a run touching N areas used to plan N times. Packing same-kind slices into one
 * invocation pays that once. Provisional at 8 (the slice cap); research R9 sets it from a measured
 * multi-area run on openwiki 0.6.0.
 */
export const MAX_PAGES_PER_INVOCATION = 8;

/**
 * Group consecutive same-kind slices of DIFFERENT areas into invocations of at most
 * `maxPagesPerInvocation` pages.
 *
 * The SLICE stays the unit of planning, backlog and carry-forward — so the committed backlog keeps its
 * shape and a failure narrows to the areas that failed. A group of one IS that slice (identity), so a
 * one-area run is exactly what it always was: same message, same verification, same report.
 */
export function packSlices(slices, { maxPagesPerInvocation = MAX_PAGES_PER_INVOCATION } = {}) {
  const groups = [];
  let current = [];
  let pages = 0;
  const flush = () => {
    if (current.length === 1) groups.push(current[0]);
    else if (current.length > 1) groups.push(invocationOf(current));
    current = [];
    pages = 0;
  };
  for (const slice of slices) {
    const n = slice.pages.length;
    const sameKind = current.length === 0 || current[0].kind === slice.kind;
    // Two slices of one area exist only because the planner split an area over the slice cap —
    // re-merging them would undo that decision.
    const newArea = !current.some((c) => c.area === slice.area);
    if (!sameKind || !newArea || (current.length > 0 && pages + n > maxPagesPerInvocation)) flush();
    current.push(slice);
    pages += n;
  }
  flush();
  return groups;
}

/** A multi-area invocation. `area`/`pages` are for reporting only; `parts` is what is executed. */
function invocationOf(parts) {
  return {
    parts,
    kind: parts[0].kind,
    area: parts.map((p) => p.area).join(' + '),
    pages: parts.flatMap((p) => p.pages.map((page) => `${p.area}/${page}`)),
    reason: parts.map((p) => p.reason).filter(Boolean).join('; '),
  };
}

/** The slices an invocation stands for — itself, for a one-area slice. */
export const partsOf = (work) => work.parts ?? [work];

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
  if (slice.parts) return renderMultiAreaMessage(slice.parts);
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

/**
 * The multi-area form (078 US2). Same instructions as the one-area message, one clause per area, and
 * a boundary sentence naming every listed area — the one-area wording ("exactly one area") would
 * contradict the page list. Kept separate so the one-area message stays byte-for-byte what it was.
 */
function renderMultiAreaMessage(parts) {
  const dirs = parts.map((p) => `${DEFAULT_BUNDLE}/${p.area}/`);
  const list = parts
    .flatMap((p) => p.pages.map((page) => {
      const subject = p.subjects?.[page];
      return subject ? `${DEFAULT_BUNDLE}/${p.area}/${page} (${subject})` : `${DEFAULT_BUNDLE}/${p.area}/${page}`;
    }))
    .join('; ');
  const scope = parts
    .map((p) => (p.areaExists
      ? `${DEFAULT_BUNDLE}/${p.area}/ already exists; leave the pages in it that are not listed above exactly as they are.`
      : `${DEFAULT_BUNDLE}/${p.area}/ does not exist yet, so create it.`))
    .join(' ');
  const indexes = parts.map((p) => `${DEFAULT_BUNDLE}/${p.area}/index.md`).join(', ');
  const message = [
    `Work on exactly these areas of the knowledge bundle this run: ${dirs.join(', ')}.`,
    `Write or refresh these pages, each followed by its subject in brackets where given: ${list}.`,
    scope,
    `Also update ${indexes} so that every page in each of those directories is listed in its own index, including the ones above — the conformance gate rejects an unlisted page.`,
    `Do not write anywhere else: no directory of ${DEFAULT_BUNDLE}/ other than ${dirs.join(' and ')}, and nothing outside ${DEFAULT_BUNDLE}/.`,
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
  remote = null,
  // Continue the REMOTE proposal branch when there is no local one. The caller sets this only while a
  // proposal is open: a closed-unmerged proposal's work has gone back to the backlog, and reviving its
  // commits would re-propose content a reviewer rejected.
  adoptRemote = false,
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

  // A CI runner is a fresh checkout every run: the proposal branch exists there only on the remote
  // (a remote-tracking ref at most), never under refs/heads/. Looking only at refs/heads/ therefore
  // started every CI run from the base branch, and the --force-with-lease push — whose lease is that
  // very tracking ref — replaced the open proposal wholesale. Measured on proposal #594, 2026-09-27/28:
  // a 4-page and then an 8-page paid slice discarded while the run record still listed both.
  if (!branchExists(g, branch) && remote && adoptRemote) {
    // Explicit, because a single-branch checkout carries no tracking ref at all. Absent on the remote
    // is a normal answer (no proposal has ever been pushed), so a failed fetch is not an error here.
    g('fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
    if (g('rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`).status === 0) {
      gitOrThrow(g, ['checkout', '-b', branch, `refs/remotes/${remote}/${branch}`], 'continuing the open proposal branch');
    }
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

  if (remote && reuse) {
    // The push is the irreversible step, so it checks for itself rather than trusting whatever prepared
    // the branch: every commit on the OPEN proposal must have an equivalent here (`git cherry` marks
    // one that does not with "+"). Commits already merged into the base show as equivalent, so a
    // clean rebase passes. Refusing costs this run's generation; overwriting cost two paid slices.
    g('fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
    const tracking = `refs/remotes/${remote}/${branch}`;
    if (g('rev-parse', '--verify', '--quiet', tracking).status === 0) {
      const missing = gitOrThrow(g, ['cherry', 'HEAD', tracking], 'comparing with the open proposal')
        .split('\n').filter((l) => l.startsWith('+'));
      if (missing.length > 0) {
        throw new Error(`pushing would discard ${missing.length} commit(s) from open proposal #${existing.number} on ${remote}/${branch} — refusing; the branch was not continued from the remote`);
      }
    }
  }

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
 * A run whose pages were written but never reached the proposal did NOT deal with its range, so the
 * record must not say it did: executeSlices has already advanced the marker by this point, and
 * leaving it there certifies work that exists only on a runner that is about to be thrown away.
 * Roll the marker back to where the run found it and return the run's slices to the backlog — the
 * same edge a closed-unmerged proposal takes (FR-016b). The usage stays: that money was spent.
 */
export function holdMarkerOnPublishFailure({ root = REPO_ROOT, before, slices = [] } = {}) {
  const current = readRunRecord(root);
  return writeRunRecord(root, {
    ...current,
    coveredCommit: before.coveredCommit ?? null,
    coveredAt: before.coveredAt ?? null,
    lastOutcome: 'failed',
    backlog: [...(current.backlog ?? []), ...slices],
  });
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
  // A stubbed generator needs no model check; the real one does. Explicit `preflight` wins.
  preflight = invoke === undefined ? defaultPreflight : null,
  credential = credentialFromEnv(),
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

  {
    const check = preflightGate({ dryRun, preflight, root });
    if (!check.ok) {
      // Same posture as a missing credential: exit 2, the record untouched, and never nothing-to-do.
      // A model that cannot be called is found here for the price of one token, not after a slice.
      return { outcome: 'failed', exitCode: 2, reason: 'preflight-failed', detail: check.detail ?? '', plan, results: [], pagesWritten: 0, elapsedSeconds: 0, stoppedAtBudget: false, backlog: record.backlog ?? [], deferred: [], record, persisted: false };
    }
    if (check.detail !== 'skipped') console.log(`[wiki-maintain] preflight ok — ${check.detail ?? ''}`);
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
// Enforced BETWEEN invocations (and before a retry), so an invocation already under way is never
// interrupted: the TIME budget is a deadline for STARTING work, and the overshoot is one invocation.
//
// Sized 2026-09-28 from measurement (feature 078, research R9, operator sign-off: "~8 pages per run,
// timeout 60"). On DeepSeek V4.1 Flash at page concurrency 4, one invocation of up to 8 pages is two
// waves of page workers and measured 15–23 min; WORST_INVOCATION_SECONDS allows 30. The job timeout has
// to hold the in-job debounce sleep, setup, the start deadline, one worst-case invocation and the
// publishing around it; a 4-minute start deadline is what fits that inside 60 minutes with 5 minutes' margin (the
// guard test's own arithmetic caught a 5-minute first draft at 4). In practice a run is ONE invocation —
// a second starts only if the first finished inside 4 minutes — and
// a retry happens only after a fast failure; anything else is carried to the next run. Declared
// EFFECTIVE CEILING: ≤16 pages / ~34 minutes of generation (FR-011a). The guard test derives the
// workflow's timeout-minutes from these constants rather than remembering a number.
//
// The wall-clock budget bounds RUNNER OCCUPANCY (FR-011c) — there is one CI runner and a paid job
// must not squat on it. **NEITHER BUDGET IS A MONETARY BOUND** (FR-011d): OpenWiki emits no token or
// cost data (research R1), this repository has no cost measurements, and no requirement in this
// feature asserts a spend ceiling. Do not describe these as cost controls, and do not add one back.

export const PAGE_BUDGET = MAX_PAGES_PER_INVOCATION;

/** One worst-case generator invocation (8 pages, concurrency 4): measured ≤23 min, +30% (078 R9). */
export const WORST_INVOCATION_SECONDS = 30 * 60;
/** CI time outside the budget, from the forge's step durations (078 R9): checkout, installs, plan, guard. */
export const CI_SETUP_SECONDS = 2 * 60;
/** CI time around the generator inside the execute step: preflight, verification, publishing (078 R9). */
export const CI_EXECUTE_OVERHEAD_SECONDS = 4 * 60;

/**
 * Attempts per slice before it goes back to the backlog.
 *
 * The generator is NON-DETERMINISTIC — measured, not assumed: identical slice, identical message, 3
 * verified pages on one run and nothing on the next. Retrying is the response to a flaky dependency,
 * not a way of hiding one; every attempt is reported, and the run budget still bounds the total.
 */
export const ATTEMPTS_PER_SLICE = 3;
export const TIME_BUDGET_SECONDS = 4 * 60;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// FR-005/FR-006 — the verifier
// ════════════════════════════════════════════════════════════════════════════════════════════════

const OKF_GATE = join(REPO_ROOT, 'scripts', 'check-openwiki-okf.mjs');

// ── link normalization (item #491) ──────────────────────────────────────────────────────────────
//
// The generator writes `](/openwiki/…)`, which the forge resolves against the SITE root and 404s —
// measured via POST /api/v1/markup; scripts/openwiki-links.mjs carries the evidence. The BRIEF now
// states the convention (openwiki/INSTRUCTIONS.md §6), but the brief is an instruction to a model,
// not a guarantee: the generator is free to ignore every word of it, which is the same reason
// verifySlice judges the working tree rather than believing the run message was honoured.
//
// So the harness fixes the form deterministically rather than hoping, and the OKF gate's V14 stays
// as the fail-closed backstop for anything that reaches the tree by another route.

/** Rewrite site-root-absolute body links to file-relative form in the given bundle files.
 *  Returns one entry per file actually changed. Pure text surgery: only the target inside `](…)`
 *  moves, so a page's prose cannot be altered by a normalization pass. */
export function normalizeBundleLinks({ root = REPO_ROOT, files = [] } = {}) {
  const changed = [];
  for (const rel of files) {
    const abs = join(root, rel);
    if (!existsSync(abs) || !rel.endsWith('.md')) continue;
    const before = readFileSync(abs, 'utf8');
    const { text, rewrites } = normalizeLinks(before, abs, root);
    if (rewrites.length === 0) continue;
    writeFileSync(abs, text);
    changed.push({ path: rel, rewrites });
  }
  return changed;
}

/** Every markdown file in the bundle, repository-relative — the target set for a full sweep. */
export function bundleMarkdownFiles({ root = REPO_ROOT, bundleRoot = null } = {}) {
  const dir = bundleRoot ?? join(root, DEFAULT_BUNDLE);
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(relative(root, full).split(sep).join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}


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
 * Success requires ALL FOUR, and the generator's exit status is not among them (contract C1):
 *   1. at least one CONCEPT page appeared or changed — an `index.md` refresh is not work, which is
 *      exactly what 043's false-green run produced;
 *   2. the bundle still passes the OKF conformance gate;
 *   3. every written path was permitted by openwiki/policy.yaml (FR-026e);
 *   4. no requested page was left unwritten while its cited source is newer than its stamp (#587).
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
  // Checked PER PART for a multi-area invocation (078 US2), so a failure names the area/page it is
  // about and the executor can carry forward only the areas that did not land.
  const missingParts = [];
  const missing = [];
  for (const part of partsOf(slice)) {
    const gone = (part.pages ?? []).filter((page) => !existsSync(join(bundleDir, part.area, page)));
    if (gone.length > 0) missingParts.push(part);
    missing.push(...gone.map((m) => `${part.area}/${m}`));
  }
  if (missing.length > 0) {
    violations.push(
      `${missing.length} requested page(s) do not exist after the run: ${missing.join(', ')}. ` +
      'The generator produced nothing usable for them regardless of the status it exited with.',
    );
  }
  // ...but "nothing needed changing" is only honest for a page whose source has NOT moved since the
  // page was stamped (item #587). Without this check, a slice was judged as a whole: a generator
  // that rewrote two of three pages and silently skipped the third passed, the marker moved past
  // the source change, and the skipped page was never planned again. Measured on 2026-09-26 with
  // runbooks/renovate.md. A page left unwritten while its cited source is newer than its stamp is
  // therefore named here, one page at a time, and fails the slice, so the slice is retried, goes
  // back to the backlog, and the marker is held.
  // Per part, like `missing`, so a multi-area invocation carries forward only the part that is stale.
  const staleParts = [];
  const stalePages = [];
  for (const part of partsOf(slice)) {
    const stale = (part.pages ?? []).filter((page) =>
      !missing.includes(`${part.area}/${page}`) &&
      !pagesWritten.includes(`${bundlePrefix}${part.area}/${page}`) &&
      sourceNewerThanStamp(root, join(bundleDir, part.area, page)));
    if (stale.length > 0) staleParts.push(part);
    stalePages.push(...stale.map((page) => `${part.area}/${page}`));
  }
  if (stalePages.length > 0) {
    violations.push(
      `${stalePages.length} requested page(s) were not rewritten although their cited source changed after their stamp: ` +
      `${stalePages.join(', ')}. "Nothing needed changing" needs the stamp to move; it did not.`,
    );
  }
  const noChange = missing.length === 0 && stalePages.length === 0 && pagesWritten.length === 0;

  if (policy !== null) {
    for (const p of written) {
      const decision = mayWrite(policy, p, actor);
      if (!decision.allowed) {
        violations.push(`${p} — the run may not write here: ${decision.reason}${decision.entry ? ` (policy entry \`${decision.entry.glob}\`)` : ''}`);
      }
    }
  }

  // Normalize link form BEFORE the gate reads the bundle, and only over what THIS slice wrote —
  // those paths have just cleared the policy check above. Sweeping the whole bundle here would
  // edit pages the slice never touched and that no policy decision covered, which is the kind of
  // unrequested write the verifier exists to catch.
  const normalized = normalizeBundleLinks({ root, files: written.filter((p) => p.startsWith(bundlePrefix)) });
  for (const { path, rewrites } of normalized) {
    console.log(`[wiki-maintain] normalized ${rewrites.length} site-root-absolute link(s) in ${path}`);
  }

  const okf = spawnSync(process.execPath, [OKF_GATE, '--bundle', bundleDir], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (okf.status !== 0) {
    const detail = `${okf.stdout ?? ''}${okf.stderr ?? ''}`.trim().split('\n').filter((l) => l.includes('✗')).join('; ');
    violations.push(`the bundle is no longer conformant after this slice: ${detail || 'the OKF gate failed'}`);
  }

  // Only the missing-page and stale-page checks are attributable to a part; a policy or conformance
  // violation is the whole invocation's, so it carries every part forward.
  const attributable = (missing.length > 0 ? 1 : 0) + (stalePages.length > 0 ? 1 : 0);
  const failedParts = violations.length === attributable ? [...new Set([...missingParts, ...staleParts])] : partsOf(slice);
  return { ok: violations.length === 0, noChange, pagesWritten, writtenPaths: written, violations, stalePages, failedParts };
}

/**
 * Is the page's cited source's last commit newer than the page's stamp? The same comparison the OKF
 * gate's V12 makes (commit date, never mtime; the stamp from ./openwiki-stamp.mjs), resolved against
 * the checkout being verified. Anything it cannot check (no stamp, an external or absent resource,
 * an untracked source) returns false: an unknowable page keeps the honest no-change outcome rather
 * than failing a slice on a guess.
 *
 * A date-only stamp (`…T00:00:00Z`) reads a same-day source commit as newer, so such a page is
 * retried until the generator restamps it. That errs toward retrying, never toward a silent skip.
 *
 * The stamp is the NEWEST of `generated.at`, `verified.at` and `timestamp` — the one rule V12 also
 * reads, imported rather than restated so the two cannot drift apart. A page the generator left
 * byte-identical but whose claims it verified after the source moved is therefore not stale here.
 */
function sourceNewerThanStamp(root, pageFile) {
  const fm = frontMatter(pageFile);
  const stamp = conceptStamp(fm);
  const resource = typeof fm.resource === 'string' ? fm.resource.trim().split('#')[0].split('?')[0] : '';
  if (stamp === null || resource === '' || /^[a-z][a-z0-9+.-]*:/i.test(resource)) return false;
  const stampMs = Date.parse(stamp.value);
  if (Number.isNaN(stampMs)) return false;
  const r = spawnSync('git', ['log', '-1', '--format=%cI', '--', resource], { cwd: root, encoding: 'utf8' });
  const out = r.status === 0 ? r.stdout.trim() : '';
  return out !== '' && Date.parse(out) > stampMs;
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
export function generatorEnv(runMessage, env = process.env, { usageLog = null } = {}) {
  if (SHELL_UNSAFE.test(runMessage)) {
    throw new Error('run message contains a shell metacharacter — renderRunMessage must produce one safe line');
  }
  // 078 US4: where the usage tap inside the generator writes this invocation's per-call counts.
  return { ...env, [RUN_MESSAGE_ENV]: runMessage, ...(usageLog ? { WIKI_USAGE_LOG: usageLog } : {}) };
}

function defaultInvoke(slice, { root, usageLog = null }) {
  const message = slice.runMessage ?? renderRunMessage(slice);
  const [cmd, ...args] = generatorCommand();
  return spawnSync(cmd, args, { cwd: root, stdio: 'inherit', encoding: 'utf8', env: generatorEnv(message, process.env, { usageLog }) });
}

const PRICE_TABLE = join(REPO_ROOT, 'scripts', 'wiki-provider-prices.json');

/** Provider, model and tier this run resolves to, plus the dated price table — or null if unresolvable. */
export function defaultUsageContext(env = process.env) {
  try {
    const { provider, modelId, tier } = resolveWikiProvider(env);
    return { provider, model: modelId, tier, prices: JSON.parse(readFileSync(PRICE_TABLE, 'utf8')) };
  } catch {
    return null; // priced as "not captured", never guessed
  }
}

/** Price one invocation's usage log; any failure to read or price it is NOT_CAPTURED, never zero. */
function invocationUsage(logPath, usage) {
  if (!usage) return NOT_CAPTURED;
  try {
    const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    return summarizeUsage(text, usage);
  } catch (err) {
    console.error(`[wiki-maintain] usage not priced: ${err.message}`);
    return NOT_CAPTURED;
  }
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
  usage = defaultUsageContext(),
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
  const usageSummaries = [];

  // 078 US2: slices are packed into invocations so the generator's fixed planning pass is paid once
  // per group of areas. Everything carried forward below is expressed in SLICES (the parts), never
  // in groups, so the committed backlog keeps its shape.
  const work = packSlices(queue);
  const remainingParts = (from) => work.slice(from).flatMap(partsOf);

  if (dryRun) {
    return {
      outcome: slices.length === 0 ? 'nothing-to-do' : 'dry-run',
      exitCode: 0,
      results: work.map((s) => ({ slice: s, dryRun: true, command: generatorCommand(), runMessage: s.runMessage ?? renderRunMessage(s) })),
      pagesWritten: 0,
      elapsedSeconds: elapsed(),
      stoppedAtBudget: false,
      backlog: slices,
      deferred: [],
      persisted: false,
    };
  }

  for (const [i, slice] of work.entries()) {
    // Budgets are checked BETWEEN slices, never inside one: interrupting a slice mid-generation would
    // leave a half-written area, which is a conformance failure rather than a saving. The overshoot is
    // therefore bounded at one slice — the declared effective ceiling in the header comment.
    if (i > 0 && (pagesWritten >= pageBudget || elapsed() >= timeBudgetSeconds)) {
      stoppedAtBudget = true;
      backlog.push(...remainingParts(i));
      deferred.push(...remainingParts(i));
      break;
    }

    // RETRY, for residual variance only.
    //
    // CORRECTED 2026-08-01. This comment used to say the ~50% zero-page rate was "not a bug to be
    // found in this code — it is a property of the dependency". THAT WAS WRONG, and it was wrong in
    // the specific way that stops people looking: it named the symptom (non-determinism) and served
    // it as the cause. The cause was a fixed, deterministic, silent per-turn output-token ceiling.
    //
    // openwiki never passes `maxTokens`, so @langchain/anthropic prefix-matches the model id against
    // a hard-coded table and falls back to 4096 on a miss. `claude-sonnet-5` — the id this repo
    // pinned — is absent from that table. A turn truncated at 4096 before it opens a `tool_use` block
    // returns an assistant message with zero tool calls, which is exactly LangGraph's ReAct stop
    // condition: the graph exits cleanly, openwiki exits 0, Nx reports success, nothing is written.
    // Measured on the wire at turn 25 of a real run: stop_reason=max_tokens, output_tokens=4096, no
    // tool call. Full write-up and reproduction:
    // specs/044-openwiki-automation-migration/HANDOFF-generator-reliability-ANSWER.md
    //
    // The target now pins a model the table covers (16384), and
    // scripts/__tests__/wiki-maintain.guard.test.mjs fails any id that lands back on the fallback.
    //
    // Retry SURVIVES that fix, but its job is now the ordinary residual variance of a model doing
    // open-ended work — not a systematic ceiling. The distinction matters operationally: against a
    // ceiling, retrying is close to useless, because every attempt re-runs into the same wall and the
    // apparent independence of attempts is an illusion. Against residual variance the attempts really
    // are independent, so the arithmetic below is sound rather than decorative. Bounded by the same
    // page and wall-clock budgets as everything else, and every attempt is reported, so a slice that
    // fails repeatedly is still visible rather than buried under a retry.
    //
    // If the zero-page rate is ever materially above zero again, DO NOT reach for a fourth attempt.
    // Measure the wire first — ANTHROPIC_BASE_URL accepts a pass-through proxy, which is how this was
    // found, and openwiki surfaces no stop_reason of its own.
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
    // One usage log per invocation, shared by its retries — a retry's tokens are real spend too.
    const usageDir = mkdtempSync(join(tmpdir(), 'wiki-usage-'));
    const usageLog = join(usageDir, 'usage.jsonl');
    for (let attempt = 1; attempt <= attemptsPerSlice; attempt++) {
      attempts = attempt;
      try {
        invocation = invoke(slice, { root, bundleRoot: bundleDir, attempt, usageLog });
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

    const spent = invocationUsage(usageLog, usage);
    rmSync(usageDir, { recursive: true, force: true });
    usageSummaries.push(spent);
    console.log(spent === NOT_CAPTURED
      ? `[wiki-maintain] usage ${slice.area}/: not captured`
      : `[wiki-maintain] usage ${slice.area}/: ${spent.calls} call(s), ${spent.uncached} uncached / ${spent.cached} cached / ${spent.output} output tokens, ~$${spent.estCostUsd} (${spent.provider}${spent.tier ? `/${spent.tier}` : ''}, prices ${spent.priceTable})`);

    results.push({ slice, ...verdict, attempts, invocationError: invocation?.error ?? null, usage: spent });

    if (!verdict.ok) {
      failed = true;
      consecutive += 1;
      // Only the parts that did not land (a missing-page failure is attributable per area); a policy
      // or conformance violation carries every part of the invocation forward.
      backlog.push(...(verdict.failedParts ?? partsOf(slice)));
      if (consecutive >= maxConsecutiveFailures) {
        // Not "this slice is bad" any more — something about the run is.
        stoppedAtFailureLimit = true;
        backlog.push(...remainingParts(i + 1));
        break;
      }
      continue;
    }
    consecutive = 0;
    pagesWritten += verdict.pagesWritten.length;
  }

  const outcome = failed ? 'failed' : slices.length === 0 ? 'nothing-to-do' : 'completed';
  const runUsage = sumUsage(usageSummaries);

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
    // 078 US4: estimated from the tap's counts and a dated price table; NOT_CAPTURED, never zero.
    lastRunUsage: runUsage,
  });

  const exitCode = failed ? 1 : stoppedAtBudget || backlog.length > 0 ? 3 : 0;

  return { outcome, exitCode, results, pagesWritten, elapsedSeconds: elapsed(), stoppedAtBudget, stoppedAtFailureLimit, backlog, deferred, usage: runUsage, record: persistedRecord, persisted: true };
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
    else if (a === '--normalize-links') setMode('normalize-links');
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

  if (opts.mode === null) throw new Error('one of --plan, --execute, --normalize-links, --should-wait or --selftest is required');
  for (const [k, v] of Object.entries({ maxSlices: opts.maxSlices, pageBudget: opts.pageBudget, timeBudgetSeconds: opts.timeBudgetSeconds })) {
    if (v !== null && (!Number.isFinite(v) || v <= 0)) throw new Error(`${k} must be a positive number`);
  }
  return opts;
}

const USAGE = [
  'Usage:',
  '  node scripts/wiki-maintain.mjs --plan    [--since <ref>] [--json]',
  '  node scripts/wiki-maintain.mjs --execute [--since <ref>] [--max-slices <n>] [--dry-run] [--json]',
  '  node scripts/wiki-maintain.mjs --normalize-links [--dry-run] [--json]  # bundle-wide link form, offline',
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

  // ── verifier: the generator that skips some of a slice's pages (item #587) ─────
  // Measured 2026-09-26: a 3-page refresh slice selected because docs/runbooks/renovate.md changed
  // came back with renovate.md untouched, was counted as "nothing needed changing", and the marker
  // moved past the change for good. A stale page left unwritten must fail, BY NAME; a page whose
  // source has not moved since its stamp may still honestly write nothing.
  const partial = mkdtempSync(join(tmpdir(), 'wiki-selftest-'));
  try {
    const bundle = join(partial, DEFAULT_BUNDLE);
    cpSync(join(fixtures, 'conformant-bundle'), bundle, { recursive: true });
    // `README.md` because the OKF gate resolves `resource` against the real checkout; the scratch
    // commit below is what gives the source a commit date newer than the stale stamps.
    writeFileSync(join(partial, 'README.md'), 'source\n');
    const page = (title, stamp) =>
      `---\ntype: Convention\ntitle: ${title}\ndescription: Written by --selftest.\nresource: README.md\ntimestamp: ${stamp}\n---\nBody.\n`;
    writeFileSync(join(bundle, 'invariants', 'stale-a.md'), page('Stale A', '2020-01-01T00:00:00Z'));
    writeFileSync(join(bundle, 'invariants', 'stale-b.md'), page('Stale B', '2020-01-01T00:00:00Z'));
    writeFileSync(join(bundle, 'invariants', 'fresh.md'), page('Fresh', '2099-01-01T00:00:00Z'));
    writeFileSync(join(bundle, 'invariants', 'index.md'),
      '# Invariants\n- [Auth Chain](auth-chain.md)\n- [Stale A](stale-a.md)\n- [Stale B](stale-b.md)\n- [Fresh](fresh.md)\n');
    for (const args of [['init', '-q'], ['config', 'user.email', 'selftest@example.invalid'], ['config', 'user.name', 'selftest'], ['add', '-A'], ['commit', '-qm', 'baseline']]) {
      spawnSync('git', args, { cwd: partial, encoding: 'utf8' });
    }

    const skipped = executeSlices({
      root: partial,
      slices: [{ area: 'invariants', pages: ['stale-a.md', 'stale-b.md'], kind: 'refresh', areaExists: true, reason: 'source changed: README.md' }],
      record: { ...readRunRecord(partial), coveredCommit: 'unchanged-marker' },
      baseCommit: 'advanced-marker',
      invoke: () => {
        writeFileSync(join(bundle, 'invariants', 'stale-a.md'), page('Stale A', '2099-01-01T00:00:00Z'));
        return { status: 0 };
      },
    });
    const why = skipped.results.flatMap((r) => r.violations ?? []).join('; ');
    check('verifier fails a slice that skipped a stale page', skipped.outcome === 'failed', `got ${skipped.outcome}`);
    check('the skipped page is named', why.includes('invariants/stale-b.md') && !why.includes('invariants/stale-a.md'), why || 'no violation');
    check('the skipped page is reported per page', JSON.stringify(skipped.results[0]?.stalePages) === '["invariants/stale-b.md"]',
      `got ${JSON.stringify(skipped.results[0]?.stalePages)}`);
    check('a skipped stale page returns to the backlog', skipped.backlog.some((s) => s.pages.includes('stale-b.md')));
    check('marker does not advance over a skipped stale page', readRunRecord(partial).coveredCommit === 'unchanged-marker');

    const accurate = executeSlices({
      root: partial,
      slices: [{ area: 'invariants', pages: ['fresh.md'], kind: 'refresh', areaExists: true, reason: 'carried forward' }],
      record: readRunRecord(partial),
      baseCommit: 'advanced-marker',
      invoke: () => ({ status: 0 }),
    });
    check('a refresh whose source did not move may write nothing', accurate.outcome === 'completed' && accurate.results[0]?.noChange === true,
      `got ${accurate.outcome}: ${accurate.results.flatMap((r) => r.violations ?? []).join('; ')}`);
    check('marker advances over an honest no-change', readRunRecord(partial).coveredCommit === 'advanced-marker');
  } finally {
    rmSync(partial, { recursive: true, force: true });
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
  console.log('✓ wiki-maintain --selftest passed (planner bounds and area derivation, shell-safe run message, zero-page detection, per-page stale-skip detection, conformance regression, marker advance/hold, policy write scope)');
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
  if (result.usage !== undefined) {
    const u = result.usage;
    console.log(u === NOT_CAPTURED || typeof u !== 'object'
      ? '[wiki-maintain] run usage: not captured'
      : `[wiki-maintain] run usage: ~$${u.estCostUsd} over ${u.calls} call(s) in ${u.invocations} invocation(s)` +
        `${u.invocationsNotCaptured ? ` (${u.invocationsNotCaptured} not captured — a PARTIAL total)` : ''}` +
        `, ${u.provider}${u.tier ? `/${u.tier}` : ''}, prices ${u.priceTable}`);
  }
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

  if (opts.mode === 'normalize-links') {
    // A bundle-wide sweep, offline and free. `verifySlice` normalizes what a slice writes, which
    // covers everything the generator produces FROM NOW ON; this is how a bundle that already
    // contains the bad form is brought into line without hand-editing generated pages.
    const files = bundleMarkdownFiles({ root: REPO_ROOT });
    if (opts.dryRun) {
      const would = files.flatMap((rel) => {
        const abs = join(REPO_ROOT, rel);
        const { rewrites } = normalizeLinks(readFileSync(abs, 'utf8'), abs, REPO_ROOT);
        return rewrites.length === 0 ? [] : [{ path: rel, rewrites }];
      });
      if (opts.json) console.log(JSON.stringify({ dryRun: true, files: would }, null, 2));
      else {
        for (const { path, rewrites } of would) for (const r of rewrites) console.log(`${path}:${r.line}  ${r.from}  →  ${r.to}`);
        const n = would.reduce((a, f) => a + f.rewrites.length, 0);
        console.log(`[wiki-maintain] ${n} link(s) in ${would.length} file(s) would be rewritten — dry run, nothing written.`);
      }
      return 0;
    }
    const changed = normalizeBundleLinks({ root: REPO_ROOT, files });
    const total = changed.reduce((a, f) => a + f.rewrites.length, 0);
    if (opts.json) console.log(JSON.stringify({ dryRun: false, files: changed }, null, 2));
    else {
      for (const { path, rewrites } of changed) console.log(`[wiki-maintain] ${path}: ${rewrites.length} link(s) rewritten`);
      console.log(`[wiki-maintain] ${total} site-root-absolute link(s) rewritten across ${changed.length} file(s).`);
    }
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
    // Accepts either name. The dev container supplies only MCM_ANTHROPIC_API_KEY, because exporting
    // the raw ANTHROPIC_API_KEY into the shell makes Claude Code bill the pay-per-token API instead
    // of the subscription (see .devcontainer/devcontainer.json). CI still sets the raw name.
    let provider;
    try {
      provider = resolveWikiProvider();
    } catch (err) {
      console.error(`[wiki-maintain] ${err.message}`);
      return 2;
    }
    if (!opts.dryRun && !credentialFromEnv()) {
      console.error(`[wiki-maintain] No ${provider.provider} credential (${provider.credential.accepted.join(' / ')}) — --execute needs it.`);
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

    // 078 FR-005: prove the configured model is callable before touching the proposal branch or
    // paying for a slice. Exit 2 like a missing credential — never nothing-to-do, record untouched.
    const check = preflightGate({ dryRun: opts.dryRun, root: REPO_ROOT });
    if (!check.ok) {
      console.error(`[wiki-maintain] ✗ preflight failed — ${check.detail}`);
      console.error('[wiki-maintain] The configured model could not be called; no slice was attempted and the record is unchanged.');
      return 2;
    }
    if (check.detail !== 'skipped') console.log(`[wiki-maintain] preflight ok — ${check.detail}`);

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
      prepareProposalBranch({
        root: REPO_ROOT,
        baseBranch: process.env.FORGE_BASE_BRANCH ?? 'main',
        remote: process.env.FORGE_REMOTE ?? 'origin',
        // Continue the remote branch only while its proposal is open; see prepareProposalBranch.
        adoptRemote: reconciled.action === 'still-open' || reconciled.action === 'adopted',
      });
    }

    const recordBefore = readRunRecord(REPO_ROOT);
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
      const landed = result.results.filter((r) => r.ok).map((r) => r.slice);
      let proposal;
      try {
        proposal = await publishProposalAsync({
          root: REPO_ROOT,
          forge,
          baseBranch: process.env.FORGE_BASE_BRANCH ?? 'main',
          body: proposalBody(plan, result),
          slices: landed,
          remote: process.env.FORGE_REMOTE ?? 'origin',
          returnTo: process.env.FORGE_BASE_BRANCH ?? 'main',
        });
      } catch (err) {
        console.error(`[wiki-maintain] could not publish the proposal: ${err.message}`);
        spawnSync('git', ['checkout', process.env.FORGE_BASE_BRANCH ?? 'main'], { cwd: REPO_ROOT, stdio: 'ignore' });
        holdMarkerOnPublishFailure({ root: REPO_ROOT, before: recordBefore, slices: landed });
        console.error('[wiki-maintain] marker held and this run\'s slices returned to the backlog — nothing was proposed.');
        return 1;
      }
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

