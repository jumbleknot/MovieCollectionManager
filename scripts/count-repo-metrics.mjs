#!/usr/bin/env node
// Counts the repository for the measurement log in docs/MCM-Learnings.md.
//
// WHY THIS EXISTS. The log's July and October columns were first counted by hand, two different
// ways, so part of every difference between them was method, not growth. This script is the one
// method from 2026-11-17 on: run it at each refresh with `--append-log docs/MCM-Learnings.md`,
// which writes the column itself (item #1133): a pasted column can be mis-copied like a hand count.
//
// WHAT IT READS. The files COMMITTED at one revision (`git ls-tree` + `git cat-file --batch`), never
// the working tree. So uncommitted edits, node_modules, build output and anything gitignored
// (secrets, .env files) are never opened, the column is exactly what its commit hash says, and an
// older commit can be counted with --rev without checking it out. Read-only, offline, no
// dependencies beyond git.
//
// Every number is a STATIC count: a line count, a file count or a pattern match. "Test cases" is
// the number of test declarations, not the number of tests a runner executes.
//
// AN ABSENT INPUT IS NEVER A ZERO. If a file the column reads (the constitution, an allowlist,
// renovate.json) does not exist at the counted revision, its row says `absent` and the run warns on
// stderr. A zero would be indistinguishable from a real count of zero, which is the "a tool's no is
// about the tool" trap in AGENTS.md. An input that exists but does not parse fails the run.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';
import { isMain } from './lib/is-main.mjs';

export const USAGE = [
  'Usage: node scripts/count-repo-metrics.mjs [--json] [--rev <commit>] [--root <dir>]',
  '       node scripts/count-repo-metrics.mjs [--rev <commit>] [--root <dir>] --append-log <file>',
  '',
  '  (no flags)           print a markdown column for the measurement log in docs/MCM-Learnings.md',
  '  --json               print every metric as JSON, for diffing two runs',
  '  --rev <commit>       count the files committed at this revision (default HEAD)',
  '  --root <dir>         count the repository containing <dir> (default: the current directory)',
  '  --append-log <file>  write the column into the table between <!-- metrics-log:start --> and',
  '                       <!-- metrics-log:end --> in <file>, in commit-date order, stamped with',
  "                       this script's version (its blob; +dirty when edited). Refuses a commit",
  '                       already logged and a shallow clone. Back-fill an older commit with --rev.',
  '  --help, -h           print this text and count nothing',
  '',
  'Reads committed files only, never the working tree. Exit 0 counted (and written), 1 refused',
  '(a failed count, or --append-log refused, leaving the file unchanged), 2 bad arguments.',
].join('\n');

// ── Reading a revision ──────────────────────────────────────────────────────────────────────────

const gitIn =
  (dir) =>
  (args, options = {}) =>
    execFileSync('git', ['-C', dir, ...args], {
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });

// Only these blobs are ever read, so only these are fetched. Everything else is listed, not opened.
const READABLE = /\.(tsx?|jsx?|mjs|cjs|py|rs|sh|ps1|rego|md|ya?ml)$/i;
const READABLE_NAMES = new Set(['renovate.json']);

/**
 * Snapshot one revision: its tracked paths and the text of every blob the counts read.
 * Paths are always repository-relative, whichever subdirectory `dir` names.
 */
export function readRevision(dir, rev = 'HEAD') {
  let top;
  try {
    top = gitIn(dir)(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`not inside a git repository: ${dir}`);
  }
  const git = gitIn(top);
  let commit;
  try {
    commit = git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
      encoding: 'utf8',
    }).trim();
  } catch {
    throw new Error(`not a commit: ${rev}`);
  }

  // `--full-tree` makes the listing independent of the directory git runs in.
  const entries = git(['ls-tree', '-r', '-z', '--full-tree', commit], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      const [mode, type, oid] = line.slice(0, tab).split(' ');
      return { mode, type, oid, path: line.slice(tab + 1) };
    })
    .filter((entry) => entry.type === 'blob');

  // A symlink's blob is its target path, not content: it is listed, and reads as empty.
  const wanted = entries.filter(
    (entry) =>
      entry.mode !== '120000' && (READABLE.test(entry.path) || READABLE_NAMES.has(entry.path)),
  );
  const oids = [...new Set(wanted.map((entry) => entry.oid))];
  const textByOid = new Map();
  if (oids.length > 0) {
    const out = git(['cat-file', '--batch'], { input: `${oids.join('\n')}\n` });
    let pos = 0;
    while (pos < out.length) {
      const newline = out.indexOf(0x0a, pos);
      const [oid, type, size] = out.subarray(pos, newline).toString('utf8').split(' ');
      if (type !== 'blob') throw new Error(`git cat-file returned ${type} for ${oid}`);
      const start = newline + 1;
      const end = start + Number(size);
      textByOid.set(oid, out.subarray(start, end).toString('utf8'));
      pos = end + 1; // the batch format ends every object with a newline
    }
  }

  const shallow =
    git(['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true';

  const text = new Map();
  for (const entry of entries) {
    if (entry.mode === '120000') text.set(entry.path, '');
    else if (textByOid.has(entry.oid)) text.set(entry.path, textByOid.get(entry.oid));
  }

  return {
    files: entries.map((entry) => entry.path),
    text,
    commit,
    // The column is dated by the commit it counted, in the committer's recorded offset.
    date: git(['show', '-s', '--format=%cs', commit], { encoding: 'utf8' }).trim(),
    // A shallow clone's rev-list stops at the shallow boundary: a confident wrong count. Null.
    shallow,
    commits: shallow
      ? null
      : Number(git(['rev-list', '--count', commit], { encoding: 'utf8' }).trim()),
  };
}

// ── Counting ────────────────────────────────────────────────────────────────────────────────────

/** Lines in a text, counting a final line that has no trailing newline. */
export const lineCountOf = (text) =>
  (text.match(/\n/g) ?? []).length + (text.length > 0 && !text.endsWith('\n') ? 1 : 0);

export const isTest = (path) =>
  /(^|\/)(__tests__|tests|e2e)\//.test(path) ||
  /\.(test|spec)\./.test(path) ||
  /^test_.*\.py$/.test(basename(path));

const LANGUAGE = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.sh': 'Shell',
  '.ps1': 'PowerShell',
  '.rego': 'Rego',
};
// Application code is what ships; the rest of production code is CI gates, scripts and policy.
const APP_LANGUAGES = new Set(['TypeScript', 'Python', 'Rust']);

const CONSTITUTION = '.specify/memory/constitution.md';
const RENOVATE = 'renovate.json';
const ALLOWLISTS = {
  sast: 'security/sast/allowlist.yaml',
  dast: 'security/zap/allowlist.yaml',
  image: 'security/infra-images/allowlist.yaml',
};

/** Every metric for one revision snapshot (see readRevision). Pure: no I/O. */
export function countMetrics(snapshot) {
  const { files } = snapshot;
  const missingInputs = [];
  const has = (path) => snapshot.text.has(path);
  const read = (path) => {
    if (!snapshot.text.has(path)) throw new Error(`internal: ${path} was not fetched`);
    return snapshot.text.get(path);
  };
  /** Read a single input the column depends on; record it and return null when it is absent. */
  const input = (path) => {
    if (has(path)) return read(path);
    missingInputs.push(path);
    return null;
  };
  const lineCount = (path) => lineCountOf(read(path));
  const matches = (path, pattern) => (read(path).match(pattern) ?? []).length;
  const sum = (paths, fn) => paths.reduce((total, path) => total + fn(path), 0);
  const under = (prefix) => files.filter((path) => path.startsWith(prefix));
  const withText = (paths, pattern) => paths.filter((path) => pattern.test(read(path))).length;

  // ── Code ──────────────────────────────────────────────────────────────────────────────────────
  const tally = () => ({ files: 0, lines: 0, byLanguage: {} });
  const add = (bucket, language, lines) => {
    bucket.files += 1;
    bucket.lines += lines;
    const entry = (bucket.byLanguage[language] ??= { files: 0, lines: 0 });
    entry.files += 1;
    entry.lines += lines;
  };
  const production = tally();
  const test = tally();
  for (const path of files) {
    const language = LANGUAGE[extname(path).toLowerCase()];
    if (language) add(isTest(path) ? test : production, language, lineCount(path));
  }
  // Maestro flows are YAML, so the extension table misses them; a flow's header declares its app.
  const maestroFlows = files.filter(
    (path) => /\.ya?ml$/.test(path) && isTest(path) && /^appId:/m.test(read(path)),
  );
  for (const path of maestroFlows) add(test, 'Maestro', lineCount(path));

  const linesWhere = (bucket, keep) =>
    Object.entries(bucket.byLanguage)
      .filter(([language]) => keep(language))
      .reduce((total, [, entry]) => total + entry.lines, 0);

  const testFiles = files.filter(isTest);
  const testCases = {
    jsTs: sum(
      testFiles.filter((path) => /\.(m?[jt]sx?|cjs)$/.test(path)),
      (path) => matches(path, /^\s*(it|test)(\.each\([^)]*\))?(\.only|\.skip)?\(/gm),
    ),
    pytest: sum(
      testFiles.filter((path) => path.endsWith('.py')),
      (path) => matches(path, /^\s*(async\s+)?def test_/gm),
    ),
    // Anchored at the start of a line, so a `#[test]` quoted in a comment or string is not a test.
    rust: sum(
      files.filter((path) => path.endsWith('.rs')),
      (path) => matches(path, /^\s*#\[(tokio::)?test\b/gm),
    ),
  };
  testCases.total = testCases.jsTs + testCases.pytest + testCases.rust;

  // ── Documentation ─────────────────────────────────────────────────────────────────────────────
  const AGENT_GUIDANCE = ['.claude/', '.github/', '.codex/', '.opencode/', '.agents/', '.specify/'];
  const docArea = (path) => {
    if (path.startsWith('specs/')) return 'specs';
    if (path.startsWith('docs/')) return 'docs';
    if (path.startsWith('openwiki/')) return 'openwiki';
    if (!path.includes('/') || AGENT_GUIDANCE.some((prefix) => path.startsWith(prefix))) {
      return 'agentGuidance';
    }
    return 'other';
  };
  const documentation = { files: 0, lines: 0, byArea: {} };
  for (const path of files) {
    // A markdown file under a test folder is a fixture, not documentation.
    if (!path.endsWith('.md') || isTest(path)) continue;
    const lines = lineCount(path);
    documentation.files += 1;
    documentation.lines += lines;
    const entry = (documentation.byArea[docArea(path)] ??= { files: 0, lines: 0 });
    entry.files += 1;
    entry.lines += lines;
  }

  // ── Spec Kit ──────────────────────────────────────────────────────────────────────────────────
  const specFolders = [...new Set(under('specs/').map((path) => path.split('/')[1]))].filter(
    (name) => /^\d{3}-/.test(name),
  );
  const featureNumbers = specFolders.map((name) => name.slice(0, 3));
  const artefact = (name) => files.filter((path) => new RegExp(`^specs/[^/]+/${name}$`).test(path));
  const taskLists = artefact('tasks\\.md');
  const specKit = {
    featureFolders: specFolders.length,
    // A string, so the log keeps the three-digit form the folders use ("082", not 82).
    highestFeatureNumber: featureNumbers.length ? featureNumbers.sort().at(-1) : null,
    // Numbers used by more than one folder: why the folder count can exceed the numbers in use.
    reusedFeatureNumbers: [
      ...new Set(featureNumbers.filter((n, i) => featureNumbers.indexOf(n) !== i)),
    ].sort(),
    specs: artefact('spec\\.md').length,
    plans: artefact('plan\\.md').length,
    taskLists: taskLists.length,
    research: artefact('research\\.md').length,
    taskListsWithVerifyRed: withText(taskLists, /Verify RED/),
    taskListsWithVerifyOrExpectedRed: withText(taskLists, /(verify|expected) red/i),
    taskListsWithConvergencePhase: withText(taskLists, /^## Phase \d+: Convergence/m),
    plansWithConstitutionCheck: withText(artefact('plan\\.md'), /Constitution Check/),
    specsWithClarifications: withText(artefact('spec\\.md'), /^## Clarifications/m),
  };

  // ── The four layers ───────────────────────────────────────────────────────────────────────────
  const constitutionText = input(CONSTITUTION);
  const constitution =
    constitutionText === null
      ? null
      : {
          lines: lineCountOf(constitutionText),
          version: constitutionText.match(/\*\*Version\*\*:\s*([\d.]+)/)?.[1] ?? null,
          // The first entry in the version history is the ratification, not an amendment.
          amendments: Math.max(
            0,
            (constitutionText.match(/^- v\d+\.\d+\.\d+:/gm) ?? []).length - 1,
          ),
        };

  // The instruction file is whichever of the two holds the gates. Since 2026-11-16 that is
  // AGENTS.md, with CLAUDE.md a shim that imports it; before then the gates lived in CLAUDE.md.
  const gatesIn = (path) => {
    if (!has(path)) return 0;
    const section = read(path)
      .split(/^## /m)
      .find((part) => part.startsWith('Gates'));
    return (section?.match(/^- \*\*/gm) ?? []).length;
  };
  // Before the Gates section existed (mid-2026) the instructions were CLAUDE.md alone: report it
  // with 0 gates rather than as absent, which would claim the file did not exist.
  const instructionPath =
    ['AGENTS.md', 'CLAUDE.md'].find((path) => gatesIn(path) > 0) ??
    (has('CLAUDE.md') ? 'CLAUDE.md' : null);
  if (instructionPath === null) missingInputs.push('AGENTS.md or CLAUDE.md');
  const instructionFile =
    instructionPath === null
      ? null
      : {
          path: instructionPath,
          lines: lineCount(instructionPath),
          bytes: Buffer.byteLength(read(instructionPath)),
          gates: gatesIn(instructionPath),
        };

  const wikiPages = under('openwiki/').filter((path) => path.endsWith('.md'));
  const knowledgePages = {
    files: wikiPages.length,
    derived: withText(wikiPages, /^resource:/m),
    indexes: wikiPages.filter((path) => basename(path) === 'index.md').length,
  };

  const decisionsAndRunbooks = {
    adrs: under('docs/decisions/').filter((path) => /\/ADR-\d+/.test(path)).length,
    runbooks: under('docs/runbooks/').filter((path) => path.endsWith('.md')).length,
    proposals: under('docs/proposals/').length,
  };

  // ── The harness ───────────────────────────────────────────────────────────────────────────────
  const workflows = under('.forgejo/workflows/').filter((path) => /\.ya?ml$/.test(path));
  const jobsIn = (path) => {
    const body = read(path).split(/^jobs:\s*$/m)[1] ?? '';
    return (body.match(/^ {2}[A-Za-z0-9_-]+:\s*$/gm) ?? []).length;
  };
  const scriptTests = under('scripts/__tests__/').filter((path) => /\.test\.[a-z]+$/.test(path));
  const ci = {
    workflows: workflows.length,
    yamlLines: sum(workflows, lineCount),
    jobs: sum(workflows, jobsIn),
    checkScripts: files.filter((path) => /^scripts\/check-[^/]+\.mjs$/.test(path)).length,
    scriptTestFiles: scriptTests.length,
    guardTestFiles: scriptTests.filter((path) => path.includes('.guard.')).length,
  };

  const entriesIn = (path, pattern) => {
    const text = input(path);
    return text === null ? null : (text.match(pattern) ?? []).length;
  };
  const security = {
    customSemgrepRules: under('security/sast/rules/').filter(
      (path) => /\.ya?ml$/.test(path) && !/\.test\./.test(path),
    ).length,
    sastAllowlistEntries: entriesIn(ALLOWLISTS.sast, /^\s*- scanner:/gm),
    dastAllowlistEntries: entriesIn(ALLOWLISTS.dast, /^\s*- pluginId:/gm),
    imageAllowlistEntries: entriesIn(ALLOWLISTS.image, /^\s*- image:/gm),
  };

  let renovate = null;
  const renovateText = input(RENOVATE);
  if (renovateText !== null) {
    let config;
    try {
      config = JSON.parse(renovateText);
    } catch (err) {
      // Present but unreadable is a broken input, not a gap: fail rather than print a number.
      throw new Error(`${RENOVATE} does not parse: ${err.message}`);
    }
    const rules = config.packageRules ?? [];
    renovate = {
      packageRules: rules.length,
      customManagers: (config.customManagers ?? []).length,
      groups: new Set(rules.map((rule) => rule.groupName).filter(Boolean)).size,
      bytes: Buffer.byteLength(renovateText),
    };
  }

  const ratio = (numerator) =>
    production.lines > 0 ? Number((numerator / production.lines).toFixed(2)) : null;

  return {
    date: snapshot.date,
    commit: snapshot.commit.slice(0, 8),
    commits: snapshot.commits ?? null,
    shallow: snapshot.shallow ?? false,
    missingInputs,
    specKit,
    code: {
      production,
      applicationLines: linesWhere(production, (language) => APP_LANGUAGES.has(language)),
      toolingLines: linesWhere(production, (language) => !APP_LANGUAGES.has(language)),
      test,
      testCases,
      testLinesPerProductionLine: ratio(test.lines),
      documentationLinesPerProductionLine: ratio(documentation.lines),
    },
    documentation,
    constitution,
    instructionFile,
    knowledgePages,
    decisionsAndRunbooks,
    ci,
    security,
    renovate,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────────────────────────

const ABSENT = 'absent';
const SHALLOW = 'unavailable (shallow clone)';

/** The measures of one column, in log order, as [label, value] pairs. */
export function columnRows(metrics) {
  const { specKit, code, documentation, constitution, instructionFile, knowledgePages } = metrics;
  const { decisionsAndRunbooks, ci, security, renovate } = metrics;
  const { production, test, testCases } = code;
  const n = (value) => (value === null ? ABSENT : value.toLocaleString('en-US'));
  const k = (value) => `${Math.round(value / 1000)}k`;
  const reused = specKit.reusedFeatureNumbers.length
    ? `; ${specKit.reusedFeatureNumbers.join(', ')} used twice`
    : '';
  const rows = [
    ['Commit', `\`${metrics.commit}\``],
    [
      'Features',
      `${specKit.featureFolders} (numbered to ${specKit.highestFeatureNumber ?? ABSENT}${reused})`,
    ],
    ['Commits', metrics.shallow ? SHALLOW : n(metrics.commits)],
    [
      'Production code',
      `${n(production.lines)} lines in ${n(production.files)} files: ${k(code.applicationLines)} application, ${k(code.toolingLines)} CI/gate scripts and shell`,
    ],
    ['Test code', `${n(test.lines)} lines in ${n(test.files)} files`],
    ['Test cases (static)', n(testCases.total)],
    [
      'Documentation (markdown)',
      `${n(documentation.lines)} lines in ${n(documentation.files)} files`,
    ],
    ['Test lines per code line', String(code.testLinesPerProductionLine ?? ABSENT)],
    [
      'Documentation lines per code line',
      String(code.documentationLinesPerProductionLine ?? ABSENT),
    ],
    [
      'Constitution',
      constitution === null
        ? ABSENT
        : `${n(constitution.lines)} lines, v${constitution.version ?? '?'}, ${constitution.amendments} amendments`,
    ],
    [
      'Instruction file',
      instructionFile === null
        ? ABSENT
        : `\`${instructionFile.path}\`: ${instructionFile.lines} lines, ${
            instructionFile.gates === 0 ? 'no Gates section' : `${instructionFile.gates} gates`
          }`,
    ],
    [
      'Knowledge pages',
      `${knowledgePages.files} files, ${knowledgePages.derived} derived summaries`,
    ],
    ['ADRs / runbooks', `${decisionsAndRunbooks.adrs} / ${decisionsAndRunbooks.runbooks}`],
    ['CI workflows / jobs', `${ci.workflows} / ${ci.jobs}`],
    ['Gate scripts (`check-*`)', String(ci.checkScripts)],
    ['Script tests (guard tests)', `${ci.scriptTestFiles} (${ci.guardTestFiles})`],
    [
      'Task lists with Verify RED',
      `${specKit.taskListsWithVerifyRed} of ${specKit.taskLists} (${specKit.taskListsWithVerifyOrExpectedRed} counting "Expected RED")`,
    ],
    [
      'Allowlist entries (SAST / DAST / image)',
      `${n(security.sastAllowlistEntries)} / ${n(security.dastAllowlistEntries)} / ${n(security.imageAllowlistEntries)}`,
    ],
    [
      'Renovate rules / managers / groups',
      renovate === null
        ? ABSENT
        : `${renovate.packageRules} / ${renovate.customManagers} / ${renovate.groups}`,
    ],
  ];
  return rows;
}

/** The markdown column for the measurement log. */
export function renderColumn(metrics) {
  return [
    `| Measure | ${metrics.date} |`,
    '| --- | --- |',
    ...columnRows(metrics).map(([measure, value]) => `| ${measure} | ${value} |`),
  ].join('\n');
}

// ── The log table (--append-log) ────────────────────────────────────────────────────────────────
//
// WHY THE SCRIPT WRITES THE COLUMN. A pasted column fails the same way a hand-counted one does:
// BELAY, which ported this log, measured the copying step as causing as much of the 4.5% hand-count
// gap as the counting did. So the column goes from the count to the file with no human between.

export const LOG_START = '<!-- metrics-log:start -->';
export const LOG_END = '<!-- metrics-log:end -->';
const NOT_RECORDED = 'not recorded';
const SCRIPT_REL = 'scripts/count-repo-metrics.mjs';

/** A refusal to write the log: exit 1, and the file is left byte-for-byte as it was. */
export class LogRefusal extends Error {}

/**
 * Which version of the counting script is running: the short id of its committed blob, with
 * `+dirty` when the file differs from that blob (edited, staged or not), or `untracked` when its
 * repository's HEAD has no such file. A blob, not a commit: two commits that leave the script
 * unchanged give the same version, so the version changes exactly when the counting can.
 * Only columns with the same version were counted the same way.
 */
export function scriptVersion(scriptPath) {
  const dir = dirname(scriptPath);
  const name = basename(scriptPath);
  const git = (args) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let blob;
  try {
    blob = git(['rev-parse', '--verify', '--quiet', '--short=8', `HEAD:./${name}`]).trim();
  } catch {
    return 'untracked';
  }
  if (!blob) return 'untracked';
  let status = '';
  try {
    status = git(['status', '--porcelain', '--', name]).trim();
  } catch {
    // status failing after rev-parse succeeded would be a broken repository: say so in the stamp
    return `${blob}+unknown`;
  }
  return status ? `${blob}+dirty` : blob;
}

/** The column --append-log writes: the method, the script version, then the counted measures. */
export function logColumn(metrics, { rev, today, version }) {
  if (metrics.shallow) {
    throw new LogRefusal(
      'refusing to log a shallow clone: its commit count is unavailable (git rev-list stops at ' +
        'the shallow boundary). Count from a full clone, or run `git fetch --unshallow` first.',
    );
  }
  const method =
    rev === undefined
      ? `\`${SCRIPT_REL}\``
      : `\`${SCRIPT_REL} --rev ${metrics.commit}\`, back-filled ${today}`;
  const [blob, suffix] = version.split('+');
  const stamp =
    version === 'untracked' ? version : `blob \`${blob}\`${suffix ? `+${suffix}` : ''}`;
  return {
    date: metrics.date,
    commit: metrics.commit,
    rows: [['Method', method], ['Script version', stamp], ...columnRows(metrics)],
  };
}

// Split a table row on its unescaped pipes; the outer pipes are dropped.
const cellsOf = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
const rowLine = (cells) => `| ${cells.join(' | ')} |`;
const escapeCell = (value) => String(value).replace(/(?<!\\)\|/g, '\\|');
const dateOf = (header) => /\d{4}-\d{2}-\d{2}/.exec(header)?.[0] ?? '';
const commitOf = (cell) => /`([0-9a-f]{7,40})`/.exec(cell ?? '')?.[1] ?? null;
const sameCommit = (a, b) => a.startsWith(b) || b.startsWith(a);

/**
 * Return `markdown` with `column` ({date, commit, rows}) merged in between the log markers as a
 * new column, in commit-date order. Pure. Throws LogRefusal rather than write a doubtful table:
 * no markers, a commit already logged, or a body that is not one table.
 *
 * Order: after every column dated earlier or the same day, except that a same-day column whose
 * commit descends from the new one (`isAncestor(new, existing)`) stays after it: a back-fill of
 * an earlier commit lands before its descendant even when both have one date.
 */
export function mergeLogColumn(markdown, column, { isAncestor = () => false } = {}) {
  const start = markdown.indexOf(LOG_START);
  const end = markdown.indexOf(LOG_END);
  if (start === -1 || end === -1 || end < start) {
    throw new LogRefusal(`the log needs both markers, ${LOG_START} then ${LOG_END}`);
  }
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const body = markdown.slice(start + LOG_START.length, end).trim();
  const lines = body ? body.split(/\r?\n/) : [];

  let headers = [];
  let labels = [];
  const values = new Map();
  if (lines.length > 0) {
    if (lines.length < 2 || !lines.every((line) => line.trim().startsWith('|'))) {
      throw new LogRefusal('the text between the log markers is not a single markdown table');
    }
    headers = cellsOf(lines[0]).slice(1);
    for (const line of lines.slice(2)) {
      const [label, ...rest] = cellsOf(line);
      if (rest.length !== headers.length) {
        throw new LogRefusal(`log row "${label}" has ${rest.length} cells for ${headers.length} columns`);
      }
      labels.push(label);
      values.set(label, rest);
    }
  }

  const logged = (values.get('Commit') ?? []).map(commitOf);
  if (logged.some((sha) => sha && sameCommit(sha, column.commit))) {
    throw new LogRefusal(
      `${column.commit} is already logged; a column is never edited. To back-fill an older ` +
        'commit, pass it with --rev.',
    );
  }

  // A measure the table has not seen yet goes after the measure that precedes it in the column.
  let previous = -1;
  for (const [label] of column.rows) {
    const at = labels.indexOf(label);
    if (at === -1) {
      labels.splice(previous + 1, 0, label);
      values.set(label, headers.map(() => NOT_RECORDED));
      previous += 1;
    } else {
      previous = at;
    }
  }

  const fresh = new Map(column.rows.map(([label, value]) => [label, escapeCell(value)]));
  let at = headers.findIndex((header, i) => {
    const date = dateOf(header);
    if (date !== column.date) return date > column.date;
    const sha = logged[i];
    return Boolean(sha) && isAncestor(column.commit, sha);
  });
  if (at === -1) at = headers.length;
  headers.splice(at, 0, column.date);
  for (const label of labels) values.get(label).splice(at, 0, fresh.get(label) ?? NOT_RECORDED);

  const table = [
    rowLine(['Measure', ...headers]),
    rowLine(['---', ...headers.map(() => '---')]),
    ...labels.map((label) => rowLine([label, ...values.get(label)])),
  ].join(eol);
  return `${markdown.slice(0, start + LOG_START.length)}${eol}${table}${eol}${markdown.slice(end)}`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────

const localDate = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

export function main(
  argv,
  {
    cwd = process.cwd(),
    out = console.log,
    err = console.error,
    scriptPath = fileURLToPath(import.meta.url),
    today = localDate(),
  } = {},
) {
  // Asking what the script does must never do it.
  if (wantsHelp(argv)) {
    out(USAGE);
    return 0;
  }
  let parsed;
  try {
    parsed = partitionArgsWithValues(argv, {
      accepted: ['--json'],
      withValues: ['--rev', '--root', '--append-log'],
      usage: USAGE,
    });
    if (parsed.flags.has('--json') && parsed.values.has('--append-log')) {
      throw new ArgvError(`--json and --append-log cannot be combined\n\n${USAGE}`);
    }
  } catch (error) {
    if (!(error instanceof ArgvError)) throw error;
    // Exit 2, the shared contract, but RETURNED rather than set on the process: main() is also
    // called in-process by its tests, and dieOnArgvError would mark the test run itself failed.
    err(error.message);
    return 2;
  }

  let metrics;
  const root = resolve(cwd, parsed.values.get('--root') ?? '.');
  try {
    metrics = countMetrics(readRevision(root, parsed.values.get('--rev') ?? 'HEAD'));
  } catch (error) {
    err(`count-repo-metrics: ${error.message}`);
    return 1;
  }

  if (metrics.missingInputs.length > 0) {
    err(
      `count-repo-metrics: absent at ${metrics.commit}, shown as "${ABSENT}" (null in --json): ` +
        metrics.missingInputs.join(', '),
    );
  }
  if (metrics.shallow) {
    err(`count-repo-metrics: ${root} is a shallow clone, so the commit count is unavailable`);
  }

  const logFile = parsed.values.get('--append-log');
  if (logFile !== undefined) {
    const path = resolve(cwd, logFile);
    try {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (error) {
        throw new LogRefusal(`cannot read ${logFile}: ${error.message}`);
      }
      const column = logColumn(metrics, {
        rev: parsed.values.get('--rev'),
        today,
        version: scriptVersion(scriptPath),
      });
      const isAncestor = (ancestor, descendant) => {
        try {
          execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', ancestor, descendant], {
            stdio: 'ignore',
          });
          return true;
        } catch {
          return false; // not an ancestor, or a commit this repository does not have
        }
      };
      writeFileSync(path, mergeLogColumn(text, column, { isAncestor }));
    } catch (error) {
      if (!(error instanceof LogRefusal)) throw error;
      err(`count-repo-metrics: ${error.message}`);
      return 1;
    }
    out(renderColumn(metrics));
    out(`count-repo-metrics: logged ${metrics.commit} (${metrics.date}) in ${logFile}`);
    return 0;
  }

  out(parsed.flags.has('--json') ? JSON.stringify(metrics, null, 2) : renderColumn(metrics));
  return 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
