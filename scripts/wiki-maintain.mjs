#!/usr/bin/env node
// OpenWiki manual rebuild of operator-named pages — features 044, 078, 098.
//
// Usage:
//   node scripts/wiki-maintain.mjs --pages <area/page.md,…> [--propose] [--dry-run] [--json]
//   node scripts/wiki-maintain.mjs --normalize-links [--dry-run] [--json]
//   node scripts/wiki-maintain.mjs --selftest
//
// Exit codes: 0 every named page landed (or a dry run / selftest passed) · 1 a named page did not
// land, or the proposal could not be published · 2 bad usage, a refused page list, a missing
// credential or a failed preflight — always BEFORE any paid call.
//
// Contract: specs/098-session-maintained-wiki/ (US4, research R7); the kept execution chain is
// specs/044-openwiki-automation-migration/contracts/cli-contracts.md (C1) and feature 078.
//
// ── What this is now (feature 098, ADR-0004) ─────────────────────────────────────────────────────
// Summaries are refreshed by the CODING SESSION that changes their source, in the same PR, and the
// required `okf` check (V17) blocks a stale one. The generator stays only as a MANUAL rebuild of the
// pages an operator names. Everything that existed to run it unattended is gone: range planning from
// a committed run record and its marker, the backlog, low-effort escalation, cooldowns, drift
// re-planning, the quiet-trigger and the Claims audit. A rebuild keeps no state between runs.
//
// ── The one thing to understand before changing this file ───────────────────────────────────────
// The generator has NO programmatic scoping surface (research R2): `openwiki code --update <message>`
// is the entire interface — no --pages, no --scope, no --max-pages. A slice is therefore an
// INSTRUCTION TO A MODEL, not a constraint on a process, and nothing stops the generator ignoring it.
// Consequently:
//   * Success is judged by pages that landed in the WORKING TREE, plus bundle conformance and
//     governance, plus every written path being permitted by openwiki/policy.yaml.
//   * The generator's exit status is NEVER consulted. Feature 043 measured the failure this exists to
//     end: 12 minutes of paid work, one index.md written, exit 0, reported as success.
//   * A landed page leaves with its source fingerprint recorded (`resource-sha256`, V17), exactly as a
//     session's `wiki-refresh.mjs --record` would leave it.
//
// **NOTHING HERE IS A MONETARY BOUND** (044 FR-011d). The job deadline bounds runner occupancy; the
// run reports its estimated spend; neither caps it.

import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadPolicy, mayWrite } from './openwiki-policy.mjs';
import { normalizeLinks } from './openwiki-links.mjs';
import { readDerivedPage, recordSourceFingerprint, staleReason } from './openwiki-fingerprint.mjs';
import { ArgvError, dieOnArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';
import { WIKI_PROVIDERS, resolveWikiProvider } from './wiki-provider.mjs';
import { summarizeUsage, sumUsage, NOT_CAPTURED, pageTrails, formatPageTrail } from './wiki-usage.mjs';
import { stepLogDir } from './ci-failure-digest.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Re-exported so a consumer needs one import, and so the run and the gate provably share one reader.
export { loadPolicy, resolvePolicy, mayWrite, isCoverageTarget } from './openwiki-policy.mjs';

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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// E1 — slices and invocations
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The largest slice feature 043 delivered reliably — and it delivered it twice (FR-002). Advisory as
 * far as the generator is concerned (research R2); binding on how many named pages one slice carries.
 *
 * 8 → 4 on 2026-11-03 (item #613), with MAX_PAGES_PER_INVOCATION: a slice may never exceed the
 * invocation cap, because the planner always admits a run's first slice whatever its size — an 8-page
 * slice would still be an 8-page invocation. FR-002's 8 is a ceiling, not a target.
 */
export const MAX_PAGES_PER_SLICE = 4;

/**
 * Pages per GENERATOR INVOCATION, across areas (feature 078, US2).
 *
 * Every invocation pays a fixed planning pass whatever its scope — ~$0.33 on Sonnet, 83% of a one-page
 * run, because openwiki's planner explores the repository before planning (research R5). Slices are
 * per area, so a run touching N areas used to plan N times. Packing same-kind slices into one
 * invocation pays that once. Provisional at 8 (the slice cap); research R9 sets it from a measured
 * multi-area run on openwiki 0.6.0.
 *
 * 8 → 4 on 2026-11-03 (item #613, operator decision). Over 85 single-invocation runs since 2026-10-08,
 * an invocation of 5–8 pages was stopped at the job deadline 69% of the time (1–2 pages: 37%; 3–4:
 * 46%), and none of 5+ pages ever ended on its own. Sizing by SOURCE lines was measured and rejected:
 * it predicts an invocation's length no better than page count (r 0.39 vs 0.37, n 35), because the
 * same page varies up to 4.3× run to run. The cost is more, smaller invocations.
 */
export const MAX_PAGES_PER_INVOCATION = 4;

/**
 * Group consecutive same-kind slices of DIFFERENT areas into invocations of at most
 * `maxPagesPerInvocation` pages.
 *
 * The SLICE stays the unit of verification, so a failure narrows to the areas that failed. A group of
 * one IS that slice (identity), so a one-area run is exactly what it always was: same message, same
 * verification, same report.
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
    // Two slices of one area exist only because pagesToSlices split an area over the slice cap —
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


/**
 * The `area/page` keys a run's results LANDED: every page of a verified invocation, plus the landed
 * pages of an invocation that failed only on other pages (verifySlice's `landedParts`, narrowed per
 * page since #720). Run 4399 kept only `r.ok` results, so a group that failed on one part lost the
 * rest; run 5010 lost two area-mates of a failed page the same way.
 */
export function landedPages(result) {
  return (result.results ?? [])
    .flatMap((r) => (r.ok ? partsOf(r.slice) : (r.landedParts ?? [])))
    .flatMap((part) => (part.pages ?? []).map((page) => `${part.area}/${page}`));
}

export const DEFAULT_BUNDLE = 'openwiki';

const RESERVED_BUNDLE_FILES = new Set(['index.md', 'INSTRUCTIONS.md', 'log.md', 'quickstart.md']);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 098 US4 — the pages an operator names
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** A page list the rebuild refuses. Always raised BEFORE any credential check, preflight or spend. */
export class PagesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PagesError';
  }
}

// One area directory and one page, nothing else: no `..`, no nesting, no absolute path. The workflow
// holds its `pages` input to a character class too; this is the check that names the bad entry.
const PAGE_KEY = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*\.md$/i;

/**
 * Turn `--pages runbooks/a.md,runbooks/b.md,projects/c.md` into slices, one per area in the order the
 * areas first appear (chunked at MAX_PAGES_PER_SLICE), each with its rendered run message.
 *
 * Refused (PagesError): an empty list, a malformed entry, a reserved file, a page that does not exist,
 * a CANONICAL page (no `resource` — hand-maintained, so the generator has nothing to rebuild it FROM),
 * and a derived page whose source no longer exists. `sourceRoot` is where a `resource` resolves: the
 * repository holding the OKF gate, which is also where V17 reads it.
 */
export function pagesToSlices({ root = REPO_ROOT, bundleRoot = null, pages, sourceRoot = REPO_ROOT } = {}) {
  const bundleDir = bundleRoot ?? join(root, DEFAULT_BUNDLE);
  const list = [...new Set((Array.isArray(pages) ? pages : String(pages ?? '').split(','))
    .map((p) => String(p).trim()).filter((p) => p !== ''))];
  if (list.length === 0) throw new PagesError('no page named — pass --pages <area/page.md>[,<area/page.md>…]');

  const byArea = new Map();
  for (const key of list) {
    if (!PAGE_KEY.test(key)) throw new PagesError(`${key}: not an area/page.md path under ${DEFAULT_BUNDLE}/`);
    const [area, page] = key.split('/');
    if (RESERVED_BUNDLE_FILES.has(page)) throw new PagesError(`${key}: a reserved bundle file, not a concept page`);
    const abs = join(bundleDir, area, page);
    if (!existsSync(abs)) throw new PagesError(`${key}: no such page in ${DEFAULT_BUNDLE}/ — a rebuild refreshes existing derived pages only`);
    const derived = readDerivedPage(abs, { root: sourceRoot });
    if (derived === null) {
      throw new PagesError(`${key}: canonical (no \`resource\`) — it is hand-maintained, and the generator has no source to rebuild it from`);
    }
    if (!existsSync(derived.resourceAbs)) {
      throw new PagesError(`${key}: its resource ${derived.resource} does not exist — re-point it (wiki-refresh skill) before rebuilding`);
    }
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(page);
  }

  const slices = [];
  for (const [area, names] of byArea) {
    for (let i = 0; i < names.length; i += MAX_PAGES_PER_SLICE) {
      const slice = { area, pages: names.slice(i, i + MAX_PAGES_PER_SLICE), kind: 'refresh', areaExists: true, subjects: {}, reason: 'named for a manual rebuild' };
      slices.push({ ...slice, runMessage: renderRunMessage(slice) });
    }
  }
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

/** A file's committed bytes at `rev`, or null when it is not there. */
function fileAt(root, rev, path) {
  const r = spawnSync('git', ['show', `${rev}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return r.status === 0 ? r.stdout : null;
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
export const PROPOSAL_TITLE = 'docs(openwiki): manual rebuild of named pages';

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
  // proposal is open: reviving a closed-unmerged proposal's commits would re-propose content a reviewer
  // rejected.
  adoptRemote = false,
  git = null,
} = {}) {
  const g = git ?? gitRunner(root);
  // Everything clean: anything dirty here means generation already happened, which is the ordering
  // mistake this check exists to catch.
  const dirty = g('status', '--porcelain').stdout.split('\n').map((l) => l.slice(3).trim()).filter((f) => f !== '');
  if (dirty.length > 0) {
    throw new Error(`the working tree is dirty (${dirty.slice(0, 3).join(', ')}) — prepare the proposal branch before generating, not after`);
  }
  return switchToProposalBranch({ g, baseBranch, branch, remote, adoptRemote });
}

function switchToProposalBranch({ g, baseBranch, branch, remote, adoptRemote }) {

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
 * The open proposal for `branch`, according to the FORGE — the only record of it since feature 098
 * retired the run record (which had lost its pointer more than once anyway, and only the forge's 409
 * stopped a SECOND proposal). FR-016: at most one open proposal, ever.
 */
export function findOpenProposal(forge, branch) {
  if (typeof forge.listPulls !== 'function') return null;
  const open = forge.listPulls({ state: 'open' }) ?? [];
  return open.find((p) => (p.head?.ref ?? p.head) === branch) ?? null;
}

export function publishProposal({
  root = REPO_ROOT,
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
  const existing = findOpenProposal(forge, branch);
  const reuse = Boolean(existing && existing.state !== 'closed');

  gitOrThrow(g, ['add', '-A'], 'staging the rebuilt pages');
  const staged = g('diff', '--cached', '--quiet').status !== 0;
  if (staged) gitOrThrow(g, ['commit', '-m', `${title}\n\n${body}`.trim()], 'committing the rebuilt pages');
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

  return { branch, number: pull.number, headCommit, slices, updatedAt: now() };
}

/**
 * The repository the forge client writes to, from GITHUB_REPOSITORY — which the runner sets for EVERY
 * event. It used to come from the event payload, which a scheduled fire did not carry (item #613
 * follow-up: runs 6539-6569 all died here). A malformed value raises; it is never guessed.
 */
export function forgeRepository(env = process.env) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(env.GITHUB_REPOSITORY ?? '');
  if (!m) throw new Error(`GITHUB_REPOSITORY must be "<owner>/<repo>", got ${JSON.stringify(env.GITHUB_REPOSITORY ?? null)}`);
  return { owner: m[1], repo: m[2] };
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
// C6 — what bounds a rebuild
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// ONE bound: the CI job deadline (#613, `deadlineCommand`). No generator is started that cannot finish
// before it, and a running one is stopped at it. The page and 4-minute starting budgets of the
// unattended run are retired with its backlog (feature 098): they existed to carry work forward to the
// next scheduled fire, and a manual rebuild has no next fire. A named page that is never attempted is
// simply `not landed` (exit 1), which the operator sees and re-dispatches.
//
// The job deadline bounds RUNNER OCCUPANCY (044 FR-011c) — there is one CI runner and a paid job must
// not squat on it. **IT IS NOT A MONETARY BOUND** (FR-011d). The guard test derives the workflow's
// timeout-minutes from the constants below rather than remembering a number.

/**
 * One worst-case generator invocation: the measured worst that ended on its own, +30%. 078 R9 had
 * ≤23 min → 30; the committed run records since measure 2958 s → 65 (item #613). Derived from
 * scripts/__tests__/fixtures/wiki-maintain/measured-invocations.json by wiki-maintain.guard.test.mjs.
 */
export const WORST_INVOCATION_SECONDS = 65 * 60;
/** CI time outside the generator, from the forge's step durations (078 R9): checkout, installs, guard. */
export const CI_SETUP_SECONDS = 2 * 60;
/** CI time around the generator inside the rebuild step: preflight, verification, publishing (078 R9). */
export const CI_EXECUTE_OVERHEAD_SECONDS = 4 * 60;

/**
 * Attempts per invocation before its pages are reported `not landed`.
 *
 * The generator is NON-DETERMINISTIC — measured, not assumed: identical slice, identical message, 3
 * verified pages on one run and nothing on the next. Retrying is the response to a flaky dependency,
 * not a way of hiding one; every attempt is reported, and the job deadline still bounds the total.
 */
export const ATTEMPTS_PER_SLICE = 3;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// FR-005/FR-006 — the verifier
// ════════════════════════════════════════════════════════════════════════════════════════════════

const OKF_GATE = join(REPO_ROOT, 'scripts', 'check-openwiki-okf.mjs');
const GOVERNANCE_GATE = join(REPO_ROOT, 'scripts', 'check-openwiki-governance.mjs');

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

// ── front-matter restore (item #777) ────────────────────────────────────────────────────────────
//
// openwiki 0.7.1 "repairs" a page whose model-written YAML does not parse (a stray `: ` in a long
// unquoted description, a duplicate key, no block at all) by REBUILDING a minimal header —
// okf/frontmatter.js repairOkfFrontmatter → rebuildMinimalConcept: `type: "Reference"`, a quoted
// title and `openwiki_generated: true`, then verified/sources/generated on finalisation (the retired
// `sources`/`verified` are stripped again by the fingerprint post-step, feature 098). It says
// nothing to the agent when the rebuild succeeds. Every repository key is gone, and G11 fails the
// proposal: #775 stacks.md, #791 renovate.md, #857 bff.md. The brief cannot guarantee valid YAML from
// a model, so the harness restores the keys from HEAD, as it fixes link form.
//
// ONLY on that marker. A page that drops `resource:` without it is the model's own edit, and the
// governance gate still refuses it (the #857 test). A page not at HEAD has nothing to restore from.

/** Keys the rebuild discards that the repository requires. `type` is replaced, not just dropped. */
// `resource-sha256` too (feature 098): the rebuild drops it like any other repository key, and HEAD's
// value is the right one for an unchanged body — a changed body is re-recorded by verifySlice anyway.
const REBUILD_RESTORED_KEYS = ['type', 'description', 'resource', 'resource-sha256', 'tags', 'timestamp'];
const REBUILD_MARKER = /^openwiki_generated:\s*true\s*$/m;

/** Split a front-matter body into top-level key blocks: a key line plus its indented continuation. */
function frontmatterBlocks(header) {
  const blocks = [];
  for (const line of header.split('\n')) {
    const key = line.match(/^([A-Za-z_][\w-]*):/)?.[1];
    if (key || blocks.length === 0) blocks.push({ key: key ?? null, lines: [line] });
    else blocks.at(-1).lines.push(line);
  }
  return blocks;
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

/** Restore the repository keys openwiki's minimal rebuild dropped, on the given bundle files.
 *  Returns one entry per file actually changed, with the keys restored and whether the hash moved. */
export function restoreRebuiltFrontmatter({ root = REPO_ROOT, files = [] } = {}) {
  const changed = [];
  for (const rel of files) {
    const abs = join(root, rel);
    if (!rel.endsWith('.md') || !isConceptPage(rel) || !existsSync(abs)) continue;
    const now = readFileSync(abs, 'utf8');
    const current = now.match(FRONTMATTER);
    if (!current || !REBUILD_MARKER.test(current[1])) continue;
    const headText = fileAt(root, 'HEAD', rel);
    const head = headText?.match(FRONTMATTER);
    if (!head || REBUILD_MARKER.test(head[1])) continue;
    const fromHead = new Map(frontmatterBlocks(head[1]).filter((b) => REBUILD_RESTORED_KEYS.includes(b.key)).map((b) => [b.key, b]));
    if (fromHead.size === 0) continue;
    // `type` is HEAD's whenever HEAD has one: the rebuild's `"Reference"` is a fallback, not a
    // classification. Every other restored key comes back only where the rebuild left it out.
    const kept = frontmatterBlocks(current[1]).filter((b) => b.key !== 'openwiki_generated' && !(b.key === 'type' && fromHead.has('type')));
    const present = new Set(kept.map((b) => b.key));
    const restored = REBUILD_RESTORED_KEYS.filter((k) => fromHead.has(k) && (k === 'type' || !present.has(k)));
    const titleAt = kept.findIndex((b) => b.key === 'title');
    const insertAt = titleAt === -1 ? 0 : titleAt + 1;
    const typeBlock = fromHead.get('type');
    const rest = restored.filter((k) => k !== 'type').map((k) => fromHead.get(k));
    const blocks = [...(typeBlock ? [typeBlock] : []), ...kept.slice(0, insertAt), ...rest, ...kept.slice(insertAt)];
    const text = `---\n${blocks.flatMap((b) => b.lines).join('\n')}\n---\n${now.slice(current[0].length)}`;
    if (text === now) continue;
    writeFileSync(abs, text);
    changed.push({ path: rel, restored });
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

const tracked = (root, path) => spawnSync('git', ['cat-file', '-e', `HEAD:${path}`], { cwd: root }).status === 0;

/** Put one path back to its committed bytes, or delete it if it is new. True when it was put back. */
function putBack(root, path) {
  if (tracked(root, path)) return spawnSync('git', ['checkout', '--', path], { cwd: root }).status === 0;
  rmSync(join(root, path), { force: true });
  return true;
}

/**
 * Restore what the invocation did not ask for (item #613, run 4606; feature 098).
 *
 * After a DEADLINE stop (`scope: 'all'`): everything the run changed is put back to its committed
 * state, or deleted if new, EXCEPT the requested pages and the requested areas' index.md. A generator
 * stopped part-way through an unrequested page would otherwise fail the whole invocation on conformance
 * and discard the requested pages with it.
 *
 * After a NORMAL exit (`scope: 'unrequested-pages'`): only the unrequested CONCEPT pages the policy lets
 * the generator write. A rebuild changes the pages the operator named and nothing else — openwiki
 * still rewrites pages it was not asked about, and proposing those would be the unrequested rewrite the
 * rebuild exists to avoid. Anything the policy FORBIDS is deliberately left in place, so verifySlice
 * still fails the invocation on it rather than this function quietly hiding a scope violation.
 *
 * A path that was already dirty before the invocation is left alone either way — its pre-run bytes
 * are not in git. Returns the paths it put back.
 */
export function revertUnrequested({ root = REPO_ROOT, bundleRoot = null, slice, before = new Map(), scope = 'all', policy = null } = {}) {
  const bundleDir = bundleRoot ?? join(root, DEFAULT_BUNDLE);
  const prefix = `${relative(root, bundleDir).split(sep).join('/')}/`;
  const keep = new Set();
  for (const part of partsOf(slice)) {
    keep.add(`${prefix}${part.area}/index.md`);
    for (const page of part.pages ?? []) keep.add(`${prefix}${part.area}/${page}`);
  }
  const reverted = [];
  for (const path of detectWrittenPaths(root)) {
    if (keep.has(path) || before.has(path)) continue;
    if (scope === 'unrequested-pages') {
      if (!path.startsWith(prefix) || !isConceptPage(path)) continue;
      if (policy !== null && !mayWrite(policy, path, 'generator').allowed) continue;
    }
    if (putBack(root, path)) reverted.push(path);
  }
  return reverted;
}

/**
 * After a failure, put the requested pages that did not land back as they were (item #685, run 4801).
 * Their bytes would otherwise ride along on a proposal of the pages that DID land. A page that was
 * already dirty before the invocation is left alone (its prior bytes are not in git), and so is an
 * UNTRACKED page: it has no committed state, and deleting it would orphan an index link that may point
 * at it. Returns the paths it restored.
 */
export function restoreFailedParts({ root = REPO_ROOT, bundleRoot = null, parts = [], before = new Map() } = {}) {
  const bundleDir = bundleRoot ?? join(root, DEFAULT_BUNDLE);
  const prefix = `${relative(root, bundleDir).split(sep).join('/')}/`;
  const dirtyNow = new Set(detectWrittenPaths(root));
  const restored = [];
  for (const part of parts) {
    for (const page of part.pages ?? []) {
      const path = `${prefix}${part.area}/${page}`;
      if (before.has(path) || !dirtyNow.has(path) || !tracked(root, path)) continue;
      if (spawnSync('git', ['checkout', '--', path], { cwd: root }).status === 0) restored.push(path);
    }
  }
  return restored;
}

export function snapshotTree(root = REPO_ROOT) {
  const paths = detectWrittenPaths(root);
  return new Map(paths.map((p) => [p, sha(join(root, p))]));
}

const isConceptPage = (relPath) => relPath.endsWith('.md') && !RESERVED_BUNDLE_FILES.has(basename(relPath));

/** A page's text after its front matter — what a rewrite of the PAGE changes, as opposed to its header. */
function bodyOf(text) {
  if (text === null) return null;
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return m ? text.slice(m[0].length) : text;
}

/**
 * Judge a slice by what actually landed.
 *
 * Success requires ALL of these, and the generator's exit status is not among them (contract C1):
 *   1. every requested page exists after the run;
 *   2. every requested page is FRESH after the run (#587, #616): either the generator rewrote its body
 *      — and it then leaves with its source fingerprint recorded (V17, feature 098) — or its recorded
 *      fingerprint still matches its source, which is an honest "nothing needed changing";
 *   3. every written path was permitted by openwiki/policy.yaml (FR-026e);
 *   4. the bundle still passes the OKF conformance gate (V17 included) and the governance gate.
 *
 * The fingerprint is recorded BEFORE the gates run, because V17 fails any derived page without a
 * current one — and only for a page whose BODY changed: a front-matter-only edit is not a refresh
 * (#616: a run that deleted a `verified:` block and touched nothing else counted as "written").
 */
export function verifySlice({ root = REPO_ROOT, bundleRoot = null, slice, policy = null, before = new Map(), actor = 'generator', sourceRoot = REPO_ROOT, now = () => new Date() } = {}) {
  const bundleDir = bundleRoot ?? join(root, DEFAULT_BUNDLE);
  const bundlePrefix = `${relative(root, bundleDir).split(sep).join('/')}/`;

  const after = snapshotTree(root);
  const written = [...after.keys()].filter((p) => !before.has(p) || before.get(p) !== after.get(p));

  const violations = [];

  const pagesWritten = written.filter((p) => p.startsWith(bundlePrefix) && isConceptPage(p));

  // The contract is the REQUESTED pages, not "some page appeared". Counting writes alone was both too
  // weak (a run that wrote unrelated pages while ignoring the request passed) and too strong (a refresh
  // of a page that is already accurate legitimately writes nothing). Checked PER PART for a multi-area
  // invocation (078 US2), so a failure names the area/page it is about.
  const missing = [];
  for (const part of partsOf(slice)) {
    const gone = (part.pages ?? []).filter((page) => !existsSync(join(bundleDir, part.area, page)));
    missing.push(...gone.map((m) => `${part.area}/${m}`));
  }
  if (missing.length > 0) {
    violations.push(
      `${missing.length} requested page(s) do not exist after the run: ${missing.join(', ')}. ` +
      'The generator produced nothing usable for them regardless of the status it exited with.',
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

  // Which requested pages the generator REWROTE — judged on the body, before any harness repair below
  // touches the bytes, and against the committed page (a new page has none, so it is a rewrite).
  const rewritten = new Set();
  for (const part of partsOf(slice)) {
    for (const page of part.pages ?? []) {
      const rel = `${bundlePrefix}${part.area}/${page}`;
      if (!written.includes(rel) || !existsSync(join(root, rel))) continue;
      if (bodyOf(readFileSync(join(root, rel), 'utf8')) !== bodyOf(fileAt(root, 'HEAD', rel))) rewritten.add(`${part.area}/${page}`);
    }
  }

  // Normalize link form and restore a minimally-rebuilt header BEFORE the gates read the bundle, and
  // only over what THIS slice wrote — those paths have just cleared the policy check above.
  for (const { path, restored } of restoreRebuiltFrontmatter({ root, bundleRoot: bundleDir, files: written.filter((p) => p.startsWith(bundlePrefix)) })) {
    console.log(`[wiki-maintain] restored ${restored.join(', ')} from HEAD in ${path} (openwiki rebuilt its front matter minimally)`);
  }
  for (const { path, rewrites } of normalizeBundleLinks({ root, bundleRoot: bundleDir, files: written.filter((p) => p.startsWith(bundlePrefix)) })) {
    console.log(`[wiki-maintain] normalized ${rewrites.length} site-root-absolute link(s) in ${path}`);
  }

  // The post-step (feature 098, FR-018): a rewritten derived page leaves with its source fingerprint
  // and without the retired `sources:`/`verified:`, exactly as `wiki-refresh.mjs --record` leaves it.
  // An unrewritten page is fresh only if its recorded fingerprint still matches (staleReason).
  const stalePages = [];
  for (const part of partsOf(slice)) {
    for (const page of part.pages ?? []) {
      const key = `${part.area}/${page}`;
      if (missing.includes(key)) continue;
      const abs = join(bundleDir, part.area, page);
      const derived = readDerivedPage(abs, { root: sourceRoot });
      if (derived === null) continue; // canonical: no fingerprint to judge
      if (rewritten.has(key) && existsSync(derived.resourceAbs)) {
        recordSourceFingerprint(abs, { root: sourceRoot, now: now() });
      } else if (staleReason(derived) !== null) {
        stalePages.push(key);
      }
    }
  }
  if (stalePages.length > 0) {
    violations.push(
      `${stalePages.length} requested page(s) are still stale after the run — their source changed since their recorded fingerprint and the body was not rewritten: ` +
      `${stalePages.join(', ')}. A front-matter-only change is not a refresh.`,
    );
  }
  const noChange = missing.length === 0 && stalePages.length === 0 && pagesWritten.length === 0;

  // V17 on a requested page that is already reported stale above is the SAME finding, attributable to
  // that page. Counting it again as a whole-bundle conformance failure would discard every landed
  // area-mate with it (#720), so it is set aside; any other finding fails the invocation.
  const okf = spawnSync(process.execPath, [OKF_GATE, '--bundle', bundleDir, '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (okf.status !== 0) {
    let findings = null;
    try { findings = JSON.parse(okf.stdout).findings; } catch { findings = null; }
    const staleAbs = new Set(stalePages.map((key) => join(bundleDir, key)));
    const other = findings === null ? null : findings.filter((f) => !(f.rule === 'V17' && staleAbs.has(resolve(REPO_ROOT, f.file))));
    if (other === null || other.length > 0) {
      const detail = other === null
        ? `${okf.stdout ?? ''}${okf.stderr ?? ''}`.trim().split('\n').filter((l) => l.includes('✗')).join('; ')
        : other.map((f) => `${f.file} — ${f.message} (${f.rule})`).join('; ');
      violations.push(`the bundle is no longer conformant after this slice: ${detail || 'the OKF gate failed'}`);
    }
  }

  // The GOVERNANCE gate too (PR #857, run 6049). The generator rewrote bff.md without its `resource:`;
  // the page stayed OKF-conformant, so this verifier passed it and the run opened a PR that guardrails
  // failed on G11. It reads the whole root (`--root`), because its rules span the bundle,
  // CLAUDE.md/AGENTS.md and the two governance files.
  //
  // A bundle WITHOUT protected.yaml is a fixture that predates governance, not a weakened production
  // run: the real repository always carries it, and guardrails' okf job fails closed without it.
  // Skipped there out loud, never silently.
  if (existsSync(join(bundleDir, 'protected.yaml'))) {
    const gov = spawnSync(process.execPath, [GOVERNANCE_GATE, '--root', root], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (gov.status !== 0) {
      const detail = `${gov.stdout ?? ''}${gov.stderr ?? ''}`.trim().split('\n').filter((l) => l.includes('✗')).join('; ');
      violations.push(`the bundle breaks openwiki governance after this slice: ${detail || 'the governance gate failed'}`);
    }
  } else {
    console.log(`[wiki-maintain] governance gate not run: no protected.yaml in ${bundlePrefix}`);
  }

  // Only the missing-page and stale-page checks are attributable to a PAGE; a policy or conformance
  // violation is the whole invocation's, so it fails every part.
  const attributable = violations.length > 0
    && violations.length === (missing.length > 0 ? 1 : 0) + (stalePages.length > 0 ? 1 : 0);
  const failedPages = violations.length === 0 ? []
    : attributable ? [...missing, ...stalePages]
      : partsOf(slice).flatMap((part) => (part.pages ?? []).map((page) => `${part.area}/${page}`));
  const narrowed = (keepKey) => partsOf(slice).flatMap(({ runMessage: _unused, ...part }) => {
    const pages = (part.pages ?? []).filter((page) => keepKey(`${part.area}/${page}`));
    return pages.length === 0 ? [] : [{ ...part, pages }];
  });
  // Failed and landed are judged per PAGE, not per part (#720): when the failure is attributable the
  // bundle is conformant and policy-clean, so the pages that did land are safe to propose.
  const failedParts = attributable ? narrowed((key) => failedPages.includes(key)) : partsOf(slice);
  const landedParts = attributable ? narrowed((key) => !failedPages.includes(key)) : [];
  return { ok: violations.length === 0, noChange, pagesWritten, writtenPaths: written, violations, missingPages: missing, stalePages, failedParts, landedParts, failedPages };
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
export function generatorEnv(runMessage, env = process.env, { usageLog = null, reasoningEffort = null } = {}) {
  if (SHELL_UNSAFE.test(runMessage)) {
    throw new Error('run message contains a shell metacharacter — renderRunMessage must produce one safe line');
  }
  // 078 US4: where the usage tap inside the generator writes this invocation's per-call counts.
  // An explicit effort overrides the job's MCM_WIKI_REASONING_EFFORT; null inherits it.
  return {
    ...env,
    [RUN_MESSAGE_ENV]: runMessage,
    ...(usageLog ? { WIKI_USAGE_LOG: usageLog } : {}),
    ...(typeof reasoningEffort === 'string' ? { MCM_WIKI_REASONING_EFFORT: reasoningEffort } : {}),
  };
}

// ── the job deadline (item #613) ────────────────────────────────────────────────────────────────
//
// A generator that hangs — a model request accepted and never answered — used to run until the CI
// job timeout killed everything: no run record, no digest, no cost line (runs 4290, 4385, 4386). The
// workflow's first step records WIKI_JOB_DEADLINE; each invocation gets the time left minus a reserve
// for verification, publishing and the record commit, and runs under GNU `timeout`, which signals the
// whole PROCESS GROUP. That matters: nx spawns openwiki as a grandchild, and a plain spawnSync timeout
// kills only nx and leaves openwiki running and writing into the tree being verified (measured).
// It relies on nx NOT using a pseudo-terminal, which puts the child in a new session outside the
// group: nx 22 uses one only when stdout is a TTY (PseudoTerminal.isSupported). In CI stdout is a
// pipe (ci-log-step), and WIKI_JOB_DEADLINE — the only thing that turns the wrapper on — is set only
// by the workflow, so an interactive local run is never wrapped.

/** Kept back from the deadline for verify, publish, the run-record commit and the digest. */
export const DEADLINE_RESERVE_MS = 8 * 60_000;
/** Below this, starting a generator is paying for work that cannot finish. */
export const MIN_GENERATOR_MS = 5 * 60_000;

/** The generator argv, wrapped in `timeout` when there is a time limit. */
export function deadlineCommand(timeoutMs) {
  if (timeoutMs === null || timeoutMs === undefined) return generatorCommand();
  return ['timeout', '--kill-after=60s', `${Math.floor(timeoutMs / 1000)}s`, ...generatorCommand()];
}

/** WIKI_JOB_DEADLINE (epoch seconds) as epoch ms, or null when unset. Malformed is an error, never ignored. */
export function jobDeadlineMs(env = process.env) {
  const raw = env.WIKI_JOB_DEADLINE;
  if (raw === undefined || raw === '') return null;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`WIKI_JOB_DEADLINE must be epoch seconds, got ${JSON.stringify(raw)}`);
  return Number(raw.trim()) * 1000;
}

function defaultInvoke(slice, { root, usageLog = null, timeoutMs = null, reasoningEffort = null } = {}) {
  const message = slice.runMessage ?? renderRunMessage(slice);
  const [cmd, ...args] = deadlineCommand(timeoutMs);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', encoding: 'utf8', env: generatorEnv(message, process.env, { usageLog, reasoningEffort }) });
  if (timeoutMs !== null && (r.status === 124 || r.status === 137)) {
    console.error(`[wiki-maintain] ✗ the generator was stopped at the job deadline after ${Math.floor(timeoutMs / 1000)}s. openwiki prints nothing until it exits, so this alone does not say whether it was slow or hung — the usage line below counts the model calls it made (#613). The slice is judged on what landed — a stopped generator usually leaves a requested page stale, which fails it.`);
  }
  return r;
}

const PRICE_TABLE = join(REPO_ROOT, 'scripts', 'wiki-provider-prices.json');

/** Provider, model and tier this run resolves to, plus the dated price table — or null if unresolvable. */
export function defaultUsageContext(env = process.env) {
  try {
    const { provider, modelId, tier, reasoningEffort } = resolveWikiProvider(env);
    return { provider, model: modelId, tier, reasoningEffort, prices: JSON.parse(readFileSync(PRICE_TABLE, 'utf8')) };
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
 * Waits before retrying a RATE-LIMITED attempt (item #683), one per retry. Run 4798 retried straight
 * into an active 429 three times in 29 seconds — attempts that cannot succeed, reported as an
 * ordinary "produced nothing". A wait is taken only while the retry would still leave the generator
 * its minimum before the job deadline; otherwise the attempt is not retried. Waiting, rather than
 * never retrying, because Fireworks' limits are per-minute windows: a minute is what clears one.
 */
export const RATE_LIMIT_BACKOFF_MS = Object.freeze([60_000, 120_000]);

/** Blocking sleep — executeSlices is synchronous by design (it is driven by spawnSync throughout). */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * How many of the usage tap's per-call lines from `offset` on answered 429 — the attempt's own
 * calls, since retries share one log. Read from the tap's `status`, never from the generator's text.
 */
export function rateLimitedCalls(logPath, offset = 0) {
  if (!existsSync(logPath)) return { limited: 0, calls: 0 };
  const lines = readFileSync(logPath, 'utf8').slice(offset).split('\n').filter((line) => line.trim() !== '');
  const limited = lines.filter((line) => {
    try { return JSON.parse(line).status === 429; } catch { return false; }
  }).length;
  return { limited, calls: lines.length };
}

/**
 * Was the attempt RATE-LIMITED, rather than merely seeing a 429 the SDK's own retry absorbed? At
 * least half its calls answered 429 — run 4798's attempts were one or two calls, each refused. A
 * stray 429 inside an otherwise working attempt would otherwise buy a needless wait and misname the
 * failure as the provider's.
 */
export const isRateLimited = ({ limited, calls }) => limited > 0 && limited * 2 >= calls;

const logSize = (logPath) => (existsSync(logPath) ? statSync(logPath).size : 0);

/**
 * Keep an invocation's per-call tap lines as a step log of this CI job (item #682), so they reach the
 * failure bundle instead of dying with the temporary usage directory. Run 4960 failed after 447 calls,
 * and only the SUM survived — not the per-call prompt sizes that would tell context compaction apart
 * from a model that stops without calling submit_page. The directory is the digest's own
 * `stepLogDir`, so writer and reader cannot drift apart. Counts, status and timing only: the tap
 * never records a prompt, a response or a header. Outside CI (no GITHUB_RUN_ID) it writes nothing.
 */
export function archiveUsageLog({ usageLog, pages = [], effort = null, env = null } = {}) {
  if (!env?.GITHUB_RUN_ID || !existsSync(usageLog)) return null;
  try {
    const dir = stepLogDir(env);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'wiki-usage.log');
    appendFileSync(target, `# invocation pages=${pages.join(',')} effort=${effort ?? 'default'}\n${readFileSync(usageLog, 'utf8')}`);
    return target;
  } catch (err) {
    console.error(`[wiki-maintain] could not keep the per-call usage log: ${err.message}`);
    return null;
  }
}

/**
 * Run the named pages' invocations in order, verifying each, stopping at CONSECUTIVE failures or at
 * the job deadline. Returns which named pages LANDED and which did not; nothing is carried anywhere
 * (feature 098: no backlog, no run record). Exit 0 when every named page landed, 1 otherwise.
 *
 * A failed invocation is recorded and the next is attempted; `maxConsecutiveFailures` in a row stops
 * the run — two consecutive failures distinguishes "this page cannot be done" from "nothing can".
 */
export function executeSlices({
  root = REPO_ROOT,
  bundleRoot = null,
  slices = [],
  policy = null,
  invoke = defaultInvoke,
  maxConsecutiveFailures = 2,
  attemptsPerSlice = ATTEMPTS_PER_SLICE,
  dryRun = false,
  clock = () => Date.now(),
  now = () => new Date(),
  usage = defaultUsageContext(),
  deadlineMs = null,
  // An explicit effort for every invocation, or null to inherit MCM_WIKI_REASONING_EFFORT from the
  // job (the workflow's `reasoning-effort` input) — which is what the generator launcher reads anyway.
  effort = null,
  sleep = sleepSync,
  // Where to keep per-call usage (#682). Null by default: the test suite runs IN CI, and a stub's
  // tap lines must not land in the test job's step logs. Only the CLI path passes process.env.
  archiveEnv = null,
  sourceRoot = REPO_ROOT,
} = {}) {
  // Time the generator may still use, or null when there is no deadline (local runs).
  const generatorAllowance = () => (deadlineMs === null ? null : deadlineMs - clock() - DEADLINE_RESERVE_MS);
  const bundleDir = bundleRoot ?? join(root, DEFAULT_BUNDLE);
  const started = clock();
  const elapsed = () => Math.round((clock() - started) / 1000);
  const requested = slices.flatMap((s) => (s.pages ?? []).map((p) => `${s.area}/${p}`));

  // 078 US2: slices are packed into invocations so the generator's fixed planning pass is paid once
  // per group of areas.
  const plan = packSlices(slices);

  if (dryRun) {
    return {
      outcome: slices.length === 0 ? 'nothing-to-do' : 'dry-run',
      exitCode: 0,
      results: plan.map((s) => ({ slice: s, dryRun: true, command: generatorCommand(), runMessage: s.runMessage ?? renderRunMessage(s) })),
      pagesWritten: 0,
      elapsedSeconds: elapsed(),
      landed: [],
      notLanded: [],
      stoppedAtDeadline: false,
    };
  }

  const results = [];
  const usageSummaries = [];
  let pagesWritten = 0;
  let stoppedAtDeadline = false;
  let stoppedAtFailureLimit = false;
  let consecutive = 0;

  for (const slice of plan) {
    const allowance = generatorAllowance();
    if (allowance !== null && allowance < MIN_GENERATOR_MS) {
      console.error(`[wiki-maintain] ${Math.max(0, Math.floor(allowance / 60_000))} min left before the job deadline's reserve — not starting a generator that cannot finish; its pages are not landed (#613).`);
      stoppedAtDeadline = true;
      break;
    }

    // RETRY, for residual variance only. The ~50% zero-page rate of 2026-07/08 was a fixed per-turn
    // output-token ceiling, not non-determinism (specs/044-openwiki-automation-migration/
    // HANDOFF-generator-reliability-ANSWER.md); wiki-maintain.guard.test.mjs pins the cap. If the
    // zero-page rate is ever materially above zero again, DO NOT reach for a fourth attempt — measure
    // the wire first.
    let verdict;
    let invocation;
    let attempts = 0;
    let stopped = false;
    let rateLimited = null; // #683: { attempts, calls } answered 429, or null
    // Snapshotted ONCE, before the first attempt: a retry must never be able to forgive what the
    // previous attempt did (re-snapshotting laundered a policy violation into a success, measured).
    const before = snapshotTree(root);
    // One usage log per invocation, shared by its retries — a retry's tokens are real spend too.
    const usageDir = mkdtempSync(join(tmpdir(), 'wiki-usage-'));
    const usageLog = join(usageDir, 'usage.jsonl');
    for (let attempt = 1; attempt <= attemptsPerSlice; attempt++) {
      attempts = attempt;
      const logOffset = logSize(usageLog);
      try {
        const timeoutMs = generatorAllowance();
        if (timeoutMs !== null && timeoutMs < MIN_GENERATOR_MS) break;
        invocation = invoke(slice, { root, bundleRoot: bundleDir, attempt, usageLog, timeoutMs, reasoningEffort: effort });
        stopped = timeoutMs !== null && (invocation?.status === 124 || invocation?.status === 137);
        const reverted = revertUnrequested({ root, bundleRoot: bundleDir, slice, before, scope: stopped ? 'all' : 'unrequested-pages', policy });
        if (reverted.length > 0) {
          console.error(`[wiki-maintain] restored ${reverted.length} path(s) this rebuild did not request${stopped ? ' (deadline stop)' : ''}: ${reverted.slice(0, 6).join(', ')}${reverted.length > 6 ? ' …' : ''}`);
        }
      } catch (err) {
        invocation = { error: err.message };
      }
      verdict = verifySlice({ root, bundleRoot: bundleDir, slice, policy, before, sourceRoot, now });
      if (verdict.ok) break;
      const tapped = rateLimitedCalls(usageLog, logOffset);
      const limited = isRateLimited(tapped) ? tapped.limited : 0;
      if (limited > 0) {
        rateLimited = { attempts: (rateLimited?.attempts ?? 0) + 1, calls: (rateLimited?.calls ?? 0) + limited };
      }
      if (attempt < attemptsPerSlice) {
        if (limited > 0) {
          // #683: a retry into an active rate limit cannot succeed. Wait it out if the retry would still
          // leave the generator its minimum before the job deadline; otherwise stop here and say why.
          const wait = RATE_LIMIT_BACKOFF_MS[Math.min(rateLimited.attempts, RATE_LIMIT_BACKOFF_MS.length) - 1];
          const left = generatorAllowance();
          if (left !== null && left - wait < MIN_GENERATOR_MS) {
            console.error(`[wiki-maintain] ${slice.area}/ attempt ${attempt} was RATE-LIMITED (${limited} call(s) answered HTTP 429) — not retrying: a ${wait / 1000}s wait would overrun the job deadline.`);
            break;
          }
          console.error(`[wiki-maintain] ${slice.area}/ attempt ${attempt} was RATE-LIMITED (${limited} call(s) answered HTTP 429) — waiting ${wait / 1000}s, then retrying (${attempt + 1}/${attemptsPerSlice}).`);
          sleep(wait);
          continue;
        }
        console.error(`[wiki-maintain] ${slice.area}/ attempt ${attempt} produced nothing usable — retrying (${attempt + 1}/${attemptsPerSlice}).`);
      }
    }

    const spent = invocationUsage(usageLog, usage ? { ...usage, reasoningEffort: effort ?? usage.reasoningEffort ?? null } : usage);
    archiveUsageLog({ usageLog, pages: partsOf(slice).flatMap((p) => (p.pages ?? []).map((page) => `${p.area}/${page}`)), effort, env: archiveEnv });
    // #719: how each failed page's worker ended, from the tap's page-attributed lines.
    if (!verdict.ok && existsSync(usageLog)) {
      const trails = pageTrails(readFileSync(usageLog, 'utf8'));
      for (const page of verdict.failedPages ?? []) {
        console.error(`[wiki-maintain] worker trail ${formatPageTrail(page, trails[page])}`);
      }
    }
    rmSync(usageDir, { recursive: true, force: true });
    usageSummaries.push(spent);
    console.log(spent === NOT_CAPTURED
      ? `[wiki-maintain] usage ${slice.area}/: not captured`
      : `[wiki-maintain] usage ${slice.area}/: ${spent.calls} call(s), ${spent.uncached} uncached / ${spent.cached} cached / ${spent.output} output tokens, ~$${spent.estCostUsd} (${spent.provider}${spent.tier ? `/${spent.tier}` : ''}${spent.reasoningEffort ? ` effort=${spent.reasoningEffort}` : ''}, prices ${spent.priceTable})`);

    results.push({ slice, ...verdict, attempts, invocationError: invocation?.error ?? null, usage: spent, deadlineStop: stopped, rateLimited });

    if (!verdict.ok) {
      consecutive += 1;
      // The pages that did not land must not ride along on a proposal of the pages that did (#685).
      const restored = restoreFailedParts({ root, bundleRoot: bundleDir, parts: verdict.failedParts ?? partsOf(slice), before });
      if (restored.length > 0) {
        console.error(`[wiki-maintain] restored ${restored.length} path(s) of the page(s) that did not land, so they cannot ride along on the proposal (#685): ${restored.slice(0, 6).join(', ')}${restored.length > 6 ? ' …' : ''}`);
      }
      const landedKeys = new Set((verdict.landedParts ?? []).flatMap((part) => (part.pages ?? []).map((page) => `${part.area}/${page}`)));
      pagesWritten += (verdict.pagesWritten ?? []).filter((p) => landedKeys.has(p.split('/').slice(-2).join('/'))).length;
      if (consecutive >= maxConsecutiveFailures) {
        stoppedAtFailureLimit = true;
        break;
      }
      continue;
    }
    consecutive = 0;
    pagesWritten += verdict.pagesWritten.length;
  }

  const landedSet = new Set(landedPages({ results }));
  const landed = requested.filter((k) => landedSet.has(k));
  const notLanded = requested.filter((k) => !landedSet.has(k));
  const outcome = slices.length === 0 ? 'nothing-to-do' : notLanded.length > 0 ? 'failed' : 'completed';
  return {
    outcome,
    exitCode: notLanded.length > 0 ? 1 : 0,
    results,
    landed,
    notLanded,
    pagesWritten,
    elapsedSeconds: elapsed(),
    stoppedAtDeadline,
    stoppedAtFailureLimit,
    usage: sumUsage(usageSummaries),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CLI
// ════════════════════════════════════════════════════════════════════════════════════════════════

const USAGE = [
  'Usage:',
  '  node scripts/wiki-maintain.mjs --pages <area/page.md,…> [--propose] [--dry-run] [--json]',
  '      PAID: rebuild the named DERIVED pages with the generator, verify each, and (with --propose)',
  '      open or update the one review proposal. A canonical, unknown or missing-source page is refused',
  '      (exit 2) before anything is spent. --dry-run prints the run messages and invokes nothing.',
  '  node scripts/wiki-maintain.mjs --normalize-links [--dry-run] [--json]  # bundle-wide link form, offline',
  '  node scripts/wiki-maintain.mjs --selftest',
  '  node scripts/wiki-maintain.mjs --help',
  '',
  'Routine freshness is NOT this tool: the session that changes a page\'s source refreshes the page',
  '(node scripts/wiki-refresh.mjs, skill wiki-refresh). Invoke through Nx:',
  '`pnpm nx wiki-maintain infrastructure-as-code --args="--pages runbooks/x.md"`.',
].join('\n');

const MODES = ['--pages', '--normalize-links', '--selftest'];

export function parseArgs(argv) {
  const { flags, values } = partitionArgsWithValues(argv, {
    accepted: ['--normalize-links', '--selftest', '--propose', '--json', '--dry-run'],
    withValues: ['--pages'],
    usage: USAGE,
  });
  const modes = MODES.filter((m) => flags.has(m) || values.has(m));
  if (modes.length !== 1) throw new ArgvError(`exactly one of ${MODES.join(', ')} is required\n\n${USAGE}`);
  const mode = modes[0].slice(2);
  if (flags.has('--propose') && mode !== 'pages') throw new ArgvError(`--propose applies only to --pages\n\n${USAGE}`);
  return { mode, pages: values.get('--pages') ?? null, propose: flags.has('--propose'), json: flags.has('--json'), dryRun: flags.has('--dry-run') };
}

// ── FR-008: --selftest ──────────────────────────────────────────────────────────
// Proves the VERIFIER still detects its cases, against T001's fixtures and a deliberately sabotaged
// generator. Offline and keyless: a check on the machinery that needed the paid machinery to run would
// be useless exactly when it matters.

function selftest() {
  const fails = [];
  const check = (name, cond, detail = '') => {
    if (!cond) fails.push(`${name}${detail ? `: ${detail}` : ''}`);
  };

  const fixtures = join(REPO_ROOT, 'scripts', '__tests__', 'fixtures', 'wiki-maintain');
  const quiet = () => {}; // the stub generator's runs are expected to fail; their log lines are noise here
  const log = console.log;
  const err = console.error;

  // ── run message ───────────────────────────────────────────────────────────────
  const message = renderRunMessage({ area: 'gotchas', pages: ['a.md', 'b.md'], areaExists: true, reason: 'x' });
  check('run message names every page', message.includes('a.md') && message.includes('b.md'));
  check('run message survives shell parsing', !/["`$\\\n\r]/.test(message), JSON.stringify(message.slice(0, 80)));

  const scratch = mkdtempSync(join(tmpdir(), 'wiki-selftest-'));
  console.log = quiet;
  console.error = quiet;
  try {
    const bundle = join(scratch, DEFAULT_BUNDLE);
    cpSync(join(fixtures, 'conformant-bundle'), bundle, { recursive: true });
    const source = 'scripts/__tests__/fixtures/wiki-maintain/source.txt';
    const page = (title, fp) =>
      `---\ntype: Convention\ntitle: ${title}\ndescription: Written by --selftest.\nresource: ${source}\nresource-sha256: ${fp}\n---\nBody.\n`;
    const current = readFileSync(join(bundle, 'invariants', 'auth-chain.md'), 'utf8').match(/^resource-sha256: (\w+)$/m)?.[1];
    writeFileSync(join(bundle, 'invariants', 'stale.md'), page('Stale', createHash('sha256').update('older').digest('hex')));
    writeFileSync(join(bundle, 'invariants', 'index.md'), '# Invariants\n- [Auth Chain](auth-chain.md)\n- [Stale](stale.md)\n');
    for (const args of [['init', '-q'], ['config', 'user.email', 'selftest@example.invalid'], ['config', 'user.name', 'selftest'], ['add', '-A'], ['commit', '-qm', 'baseline']]) {
      spawnSync('git', args, { cwd: scratch, encoding: 'utf8' });
    }

    // ── the sabotaged generator: exits 0 having written nothing ─────────────────
    const sabotaged = executeSlices({ root: scratch, slices: [{ area: 'invariants', pages: ['nothing.md'], areaExists: true, reason: 'selftest' }], invoke: () => ({ status: 0 }), attemptsPerSlice: 1 });
    check('verifier fails a zero-page slice', sabotaged.outcome === 'failed', `got ${sabotaged.outcome}`);
    check('verifier exits 1 on failure', sabotaged.exitCode === 1, `got ${sabotaged.exitCode}`);
    check('the page that did not land is named', sabotaged.notLanded.join() === 'invariants/nothing.md');

    // ── a stale page left unrewritten fails, by name (#587); a rewrite lands and is recorded ─────
    const skipped = executeSlices({ root: scratch, slices: [{ area: 'invariants', pages: ['stale.md'], kind: 'refresh', areaExists: true, reason: 'selftest' }], invoke: () => ({ status: 0 }), attemptsPerSlice: 1 });
    check('verifier fails a slice that left a stale page unrewritten', skipped.outcome === 'failed', `got ${skipped.outcome}`);
    check('the stale page is named', JSON.stringify(skipped.results[0]?.stalePages) === '["invariants/stale.md"]', JSON.stringify(skipped.results[0]?.stalePages));
    const rebuilt = executeSlices({
      root: scratch,
      slices: [{ area: 'invariants', pages: ['stale.md'], kind: 'refresh', areaExists: true, reason: 'selftest' }],
      invoke: () => {
        writeFileSync(join(bundle, 'invariants', 'stale.md'), readFileSync(join(bundle, 'invariants', 'stale.md'), 'utf8').replace('Body.', 'Body, rebuilt.'));
        return { status: 0 };
      },
    });
    check('a rewritten page lands', rebuilt.outcome === 'completed', `got ${rebuilt.outcome}: ${rebuilt.results.flatMap((r) => r.violations ?? []).join('; ')}`);
    check('a landed page carries its current source fingerprint', current !== undefined && readFileSync(join(bundle, 'invariants', 'stale.md'), 'utf8').includes(`resource-sha256: ${current}`));

    // ── a fresh page may honestly write nothing ──────────────────────────────────
    const accurate = executeSlices({ root: scratch, slices: [{ area: 'invariants', pages: ['auth-chain.md'], kind: 'refresh', areaExists: true, reason: 'selftest' }], invoke: () => ({ status: 0 }) });
    check('a page whose source did not move may write nothing', accurate.outcome === 'completed' && accurate.results[0]?.noChange === true,
      `got ${accurate.outcome}: ${accurate.results.flatMap((r) => r.violations ?? []).join('; ')}`);

    // ── non-conformant output ────────────────────────────────────────────────────
    const broken = executeSlices({
      root: scratch,
      slices: [{ area: 'invariants', pages: ['broken.md'], areaExists: true, reason: 'selftest' }],
      invoke: () => {
        writeFileSync(join(bundle, 'invariants', 'broken.md'), '---\ntitle: no type\n---\nBody.\n');
        return { status: 0 };
      },
      attemptsPerSlice: 1,
    });
    check('verifier fails a slice that broke conformance', broken.outcome === 'failed', `got ${broken.outcome}`);
    // No run record, no Claims sidecars, no manifest: a rebuild leaves no hidden bookkeeping behind.
    check('a rebuild writes no bookkeeping file', readdirSync(bundle).filter((n) => n.startsWith('.')).length === 0, readdirSync(bundle).join(','));
  } finally {
    console.log = log;
    console.error = err;
    rmSync(scratch, { recursive: true, force: true });
  }

  // ── the page list ─────────────────────────────────────────────────────────────
  for (const [label, pages] of [['an empty list', ','], ['a canonical page', 'invariants/auth-chain.md'], ['an unknown page', 'runbooks/no-such-page.md']]) {
    let refused = false;
    try { pagesToSlices({ pages }); } catch (e) { refused = e instanceof PagesError; }
    check(`the page list refuses ${label}`, refused);
  }

  // ── policy ────────────────────────────────────────────────────────────────────
  try {
    const policy = loadPolicy(REPO_ROOT);
    check('policy permits the generator inside the bundle', mayWrite(policy, 'openwiki/gotchas/x.md', 'generator').allowed);
    check('policy forbids the generator outside the bundle', !mayWrite(policy, 'docs/runbooks/local-dev.md', 'generator').allowed);
    check('policy forbids writing the protection manifest', !mayWrite(policy, 'openwiki/protected.yaml', 'generator').allowed);
    check('policy forbids writing the generation brief', !mayWrite(policy, 'openwiki/INSTRUCTIONS.md', 'generator').allowed);
  } catch (e) {
    fails.push(`policy did not load: ${e.message}`);
  }

  if (fails.length > 0) {
    console.error('✗ wiki-maintain --selftest FAILED:\n  ' + fails.join('\n  '));
    return 1;
  }
  console.log('✓ wiki-maintain --selftest passed (shell-safe run message, zero-page detection, stale-page detection by fingerprint, landed page recorded, honest no-change, conformance regression, page-list refusals, policy write scope, no run record)');
  return 0;
}

/** What a reviewer sees: what was asked for, what landed, what did not and why. */
export function proposalBody(result) {
  const lines = [
    'Manual OpenWiki rebuild of operator-named pages (feature 098: routine refreshes are made by the coding session that changes a source; this is the operator\'s rebuild path).',
    '',
    `**Outcome**: \`${result.outcome}\` — ${result.landed.length} page(s) landed, ${result.notLanded.length} not landed, in ${result.elapsedSeconds}s.`,
    '',
    'Every page below was verified by what actually appeared in the working tree, by the OKF conformance',
    'gate (V17 included — each landed page carries its source\'s current fingerprint) and by the governance',
    'gate — never by the generator\'s exit status.',
    '',
  ];
  for (const r of result.results) {
    lines.push(`- ${r.ok ? '✅' : '✗'} \`${r.slice.area}/\` — ${(r.pagesWritten ?? []).length} page(s) written: ${r.slice.pages.join(', ')}`);
    for (const v of r.violations ?? []) lines.push(`  - ${v}`);
  }
  if (result.notLanded.length > 0) lines.push('', `Not landed: ${result.notLanded.map((p) => `\`${p}\``).join(', ')} — re-dispatch them, or refresh them in a session.`);
  lines.push('', 'Review this like any hand-authored documentation change. A commit you push onto this branch survives every subsequent update — the branch is rebased and appended to, never force-replaced. A hand edit here is fine: re-record the page with `node scripts/wiki-refresh.mjs --record <page>` if its source changed.');
  return lines.join('\n');
}

/** The open proposal on the forge, or null. The forge is the only record of it (no run record). */
async function openProposalOn(forge, branch = PROPOSAL_BRANCH) {
  const open = await Promise.resolve().then(() => forge.listPulls({ state: 'open' })).catch(() => []);
  return (open ?? []).find((p) => (p.head?.ref ?? p.head) === branch) ?? null;
}

async function publishProposalAsync({ root, forge, branch = PROPOSAL_BRANCH, ...rest }) {
  const existing = await openProposalOn(forge, branch);
  if (existing) console.log(`[wiki-maintain] continuing open proposal #${existing.number}.`);

  const created = [];
  const sync = {
    listPulls: () => (existing ? [existing] : []),
    createPull: (args) => { created.push(args); return { number: -1 }; },
    updatePull: (number) => ({ number }),
  };
  const proposal = publishProposal({ root, forge: sync, branch, ...rest });

  if (created.length > 0) {
    try {
      const pull = await forge.createPull(created[0]);
      return { ...proposal, number: pull.number };
    } catch (e) {
      // 409 = one already exists for this head: a race between the look-up above and this call.
      // Adopt it rather than failing the whole run over a proposal that is already there.
      if (!/→ 409/.test(e.message)) throw e;
      const found = await openProposalOn(forge, branch);
      if (!found) throw e;
      console.log(`[wiki-maintain] a proposal for ${branch} already existed (#${found.number}) — updating it instead of opening another.`);
      await forge.updatePull(found.number, { body: rest.body, title: rest.title ?? PROPOSAL_TITLE });
      return { ...proposal, number: found.number };
    }
  }
  await forge.updatePull(existing.number, { body: rest.body, title: rest.title ?? PROPOSAL_TITLE });
  return { ...proposal, number: existing.number };
}

/**
 * The rebuild after its argument and credential checks — refuse a bad page list, preflight, prepare
 * the proposal branch, generate and verify, publish — returning the exit code. Exported so a test can
 * drive the whole sequence with a stub generator and an in-memory forge. `forge` null means no proposal.
 */
export async function executeRun({
  root = REPO_ROOT,
  bundleRoot = null,
  opts,
  policy = null,
  forge = null,
  invoke = undefined,
  preflight = undefined,
  deadlineMs = null,
  effort = null,
  baseBranch = 'main',
  remote = null,
  archiveEnv = null,
  attemptsPerSlice = ATTEMPTS_PER_SLICE,
  sourceRoot = REPO_ROOT,
} = {}) {
  let slices;
  try {
    slices = pagesToSlices({ root, bundleRoot, pages: opts.pages, sourceRoot });
  } catch (e) {
    if (!(e instanceof PagesError)) throw e;
    console.error(`[wiki-maintain] ✗ ${e.message}`);
    console.error('[wiki-maintain] Nothing was invoked.');
    return 2;
  }
  console.log(`[wiki-maintain] rebuilding ${slices.reduce((n, s) => n + s.pages.length, 0)} named page(s) in ${slices.length} slice(s):`);
  for (const s of slices) console.log(`  ${s.area}/ — ${s.pages.join(', ')}`);

  // 078 FR-005: prove the configured model is callable before touching the proposal branch or paying
  // for a slice. A stubbed generator needs no model check; the real one does.
  const check = preflightGate({ dryRun: opts.dryRun, root, preflight: preflight === undefined ? (invoke === undefined ? defaultPreflight : null) : preflight });
  if (!check.ok) {
    console.error(`[wiki-maintain] ✗ preflight failed — ${check.detail}`);
    console.error('[wiki-maintain] The configured model could not be called; nothing was attempted.');
    return 2;
  }
  if (check.detail !== 'skipped') console.log(`[wiki-maintain] preflight ok — ${check.detail}`);

  if (forge && !opts.dryRun) {
    // Continue the remote branch only while its proposal is open: a closed-unmerged proposal's commits
    // are content a reviewer rejected, and reviving them would re-propose it.
    const open = await openProposalOn(forge);
    prepareProposalBranch({ root, baseBranch, remote, adoptRemote: open !== null });
  }

  const result = executeSlices({
    root,
    bundleRoot,
    slices,
    policy,
    dryRun: opts.dryRun,
    deadlineMs,
    effort,
    archiveEnv,
    attemptsPerSlice,
    sourceRoot,
    ...(invoke === undefined ? {} : { invoke }),
  });

  reportRun(result, opts);

  if (forge && !opts.dryRun && result.landed.length > 0) {
    let proposal;
    try {
      proposal = await publishProposalAsync({
        root,
        forge,
        baseBranch,
        body: proposalBody(result),
        slices: result.landed,
        remote,
        returnTo: baseBranch,
      });
    } catch (e) {
      console.error(`[wiki-maintain] could not publish the proposal: ${e.message}`);
      spawnSync('git', ['checkout', baseBranch], { cwd: root, stdio: 'ignore' });
      console.error('[wiki-maintain] nothing was proposed; the landed pages exist only on this runner.');
      return 1;
    }
    console.log(`[wiki-maintain] proposal #${proposal.number} on ${proposal.branch} — awaiting HUMAN review. Never auto-merged.`);
  }

  return result.exitCode;
}

export function reportRun(result, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify({
      outcome: result.outcome,
      exitCode: result.exitCode,
      landed: result.landed,
      notLanded: result.notLanded,
      pagesWritten: result.pagesWritten,
      elapsedSeconds: result.elapsedSeconds,
      results: result.results.map((r) => ({
        area: r.slice.area,
        pages: r.slice.pages,
        ok: r.ok ?? null,
        pagesWritten: r.pagesWritten ?? [],
        violations: r.violations ?? [],
        rateLimited: r.rateLimited ?? null,
        command: r.command ?? null,
        runMessage: r.runMessage ?? null,
      })),
    }, null, 2));
    return;
  }

  if (result.outcome === 'dry-run') {
    console.log('[wiki-maintain] dry run — nothing was invoked. Per invocation, the command would be:');
    for (const r of result.results) {
      console.log(`  ${r.slice.area}/ → ${r.command.join(' ')}`);
      console.log(`     ${RUN_MESSAGE_ENV}=${r.runMessage}`);
    }
    return;
  }

  for (const r of result.results) {
    const tries = r.attempts > 1 ? ` after ${r.attempts} attempts` : '';
    if (r.ok && r.noChange) console.log(`[wiki-maintain] ✅ ${r.slice.area}/ — every requested page is present and current; nothing needed changing (0 written)${tries}`);
    else if (r.ok) console.log(`[wiki-maintain] ✅ ${r.slice.area}/ — ${r.pagesWritten.length} page(s) written, verified and recorded${tries}`);
    else {
      console.error(`[wiki-maintain] ✗ ${r.slice.area}/ — FAILED verification after ${r.attempts} attempt(s):`);
      for (const v of r.violations) console.error(`    ${v}`);
      if (r.invocationError) console.error(`    invocation error: ${r.invocationError}`);
      if (r.rateLimited) console.error(`    RATE-LIMITED: ${r.rateLimited.calls} call(s) answered HTTP 429 across ${r.rateLimited.attempts} attempt(s) — the provider refused, not a page the model failed to write (#683).`);
    }
  }
  if (result.stoppedAtDeadline) console.error('[wiki-maintain] stopped at the job deadline — the pages after it were not attempted.');
  if (result.stoppedAtFailureLimit) console.error('[wiki-maintain] stopped after consecutive failures — this looks like a broken run rather than a bad page.');

  console.log(`[wiki-maintain] outcome=${result.outcome} landed=${result.landed.length} not-landed=${result.notLanded.length} elapsed=${result.elapsedSeconds}s`);
  for (const p of result.landed) console.log(`[wiki-maintain] landed: ${p}`);
  for (const p of result.notLanded) console.error(`[wiki-maintain] not landed: ${p}`);
  if (result.usage !== undefined) {
    const u = result.usage;
    console.log(u === NOT_CAPTURED || typeof u !== 'object'
      ? '[wiki-maintain] run usage: not captured'
      : `[wiki-maintain] run usage: ~$${u.estCostUsd} over ${u.calls} call(s) in ${u.invocations} invocation(s)` +
        `${u.invocationsNotCaptured ? ` (${u.invocationsNotCaptured} not captured — a PARTIAL total)` : ''}` +
        `, ${u.provider}${u.tier ? `/${u.tier}` : ''}${u.reasoningEffort ? ` effort=${u.reasoningEffort}` : ''}, prices ${u.priceTable}`);
  }
}

async function main(argv) {
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return 0;
  }
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    dieOnArgvError(e, { hard: false });
    return 2;
  }

  if (opts.mode === 'selftest') return selftest();

  let policy;
  try {
    policy = loadPolicy(REPO_ROOT);
  } catch (e) {
    console.error(`[wiki-maintain] ${e.message}`);
    return 2;
  }

  if (opts.mode === 'normalize-links') {
    // A bundle-wide sweep, offline and free. `verifySlice` normalizes what a slice writes; this is how
    // a bundle that already contains the bad form is brought into line.
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

  // --pages. The page list is judged FIRST, before the credential: a refused list is exit 2 whatever
  // else is or is not configured, and it costs nothing.
  try {
    pagesToSlices({ root: REPO_ROOT, pages: opts.pages });
  } catch (e) {
    if (!(e instanceof PagesError)) throw e;
    console.error(`[wiki-maintain] ✗ ${e.message}`);
    return 2;
  }
  // A credential failure is exit 2 and is reported as such — never as "nothing to do". Accepts either
  // name: the dev container supplies only MCM_ANTHROPIC_API_KEY (CLAUDE.md); CI sets the raw name.
  let provider;
  try {
    provider = resolveWikiProvider();
  } catch (e) {
    console.error(`[wiki-maintain] ${e.message}`);
    return 2;
  }
  if (!opts.dryRun && !credentialFromEnv()) {
    console.error(`[wiki-maintain] No ${provider.provider} credential (${provider.credential.accepted.join(' / ')}) — --pages needs it. Use --dry-run for the free path.`);
    return 2;
  }

  let forge = null;
  if (opts.propose) {
    try {
      forge = forgejoClient(forgeRepository());
    } catch (e) {
      console.error(`[wiki-maintain] ${e.message}`);
      return 2;
    }
  }
  let deadlineMs;
  try {
    deadlineMs = jobDeadlineMs(process.env);
  } catch (e) {
    console.error(`[wiki-maintain] ${e.message}`);
    return 2;
  }
  return executeRun({
    root: REPO_ROOT,
    opts,
    policy,
    forge,
    deadlineMs,
    baseBranch: process.env.FORGE_BASE_BRANCH ?? 'main',
    remote: process.env.FORGE_REMOTE ?? 'origin',
    archiveEnv: process.env,
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(await main(process.argv.slice(2)));
