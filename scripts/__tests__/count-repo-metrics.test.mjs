// scripts/count-repo-metrics.mjs — the counter behind the measurement log in docs/MCM-Learnings.md.
//
// Each test pins one way the first version of the script gave a confident wrong number:
//   - run from a subdirectory, it counted only that subtree (26k "production lines", no error);
//   - it read the working tree but labelled the column with the HEAD commit;
//   - an absent input (an allowlist, renovate.json) printed as 0, indistinguishable from a real 0;
//   - an unrecognised flag was ignored, and `--root` with no value crashed with a stack trace.
//
// Every test builds its own throwaway git repository under the OS temp directory. No network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { usageNamesEveryFlag } from '../lib/argv-contract.mjs';
import {
  USAGE,
  countMetrics,
  isTest,
  lineCountOf,
  logColumn,
  main,
  mergeLogColumn,
  readRevision,
  renderColumn,
  scriptVersion,
} from '../count-repo-metrics.mjs';

let repo;

// Signing and line-ending conversion are disabled for the fixture's own commits only, so a
// developer's global git config cannot change what the fixture contains.
const git = (...args) =>
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { encoding: 'utf8' },
  ).trim();

const write = (path, text) => {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
};

const run = (argv, cwd = repo) => {
  const out = [];
  const err = [];
  const code = main(argv, { cwd, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'count-repo-metrics-'));
  execFileSync('git', ['init', '-q', repo]);
  // First commit: no allowlists, no renovate.json, so those inputs are absent here.
  write(
    'backend/src/lib.rs',
    'fn a() {}\n\n#[cfg(test)]\nmod t {\n    #[test]\n    fn b() {}\n}\n',
  );
  write('scripts/check-x.mjs', 'console.log(1);\n');
  write('scripts/__tests__/x.test.mjs', "test('a', () => {});\nit('b', () => {});\n");
  write('docs/a.md', 'one\ntwo'); // no trailing newline: still two lines
  write('specs/001-first/spec.md', '# spec\n');
  write('specs/002-second/spec.md', '# spec\n');
  write('specs/002-other/spec.md', '# spec\n');
  write(
    '.specify/memory/constitution.md',
    '- v1.0.0: ratified\n- v1.1.0: amended\n**Version**: 1.1.0\n',
  );
  write('AGENTS.md', '# x\n\n## Gates that run before you act\n\n- **one**\n- **two**\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');
  // Second commit: the inputs arrive.
  write('renovate.json', JSON.stringify({ packageRules: [{ groupName: 'g' }, {}] }));
  write('security/sast/allowlist.yaml', 'entries:\n  - scanner: semgrep\n');
  write('security/zap/allowlist.yaml', 'entries:\n  - pluginId: 1\n');
  write('security/infra-images/allowlist.yaml', '- image: a\n- image: b\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'second');
});

after(() => rmSync(repo, { recursive: true, force: true }));

test('counts the whole repository whichever subdirectory it runs from', () => {
  const fromRoot = run(['--json']);
  const fromSubdir = run(['--json'], join(repo, 'scripts'));
  const viaRoot = run(['--json', '--root', join(repo, 'backend', 'src')]);
  assert.equal(fromRoot.code, 0, fromRoot.err);
  assert.equal(fromSubdir.out, fromRoot.out, 'a subdirectory run must not count only its subtree');
  assert.equal(viaRoot.out, fromRoot.out, '--root names a repository, not a subtree');
  assert.equal(JSON.parse(fromRoot.out).code.production.lines, 7 + 1, 'lib.rs + check-x.mjs');
});

test('counts the committed revision, never the working tree', () => {
  const before = run(['--json']).out;
  write('backend/src/lib.rs', 'fn a() {}\n'.repeat(500)); // an uncommitted edit
  write('backend/src/untracked.rs', 'fn u() {}\n');
  try {
    assert.equal(run(['--json']).out, before, 'uncommitted edits must not change the column');
  } finally {
    git('checkout', '--', 'backend/src/lib.rs');
    rmSync(join(repo, 'backend/src/untracked.rs'));
  }
});

test('--rev counts an older commit without checking it out', () => {
  const head = JSON.parse(run(['--json']).out);
  const older = JSON.parse(run(['--json', '--rev', 'HEAD~1']).out);
  assert.equal(head.commits, 2);
  assert.equal(older.commits, 1);
  assert.equal(older.commit, git('rev-parse', '--short=8', 'HEAD~1'));
});

test('an absent input renders as "absent" and warns, never as 0', () => {
  const result = run(['--rev', 'HEAD~1']);
  assert.equal(result.code, 0);
  assert.match(
    result.out,
    /\| Allowlist entries \(SAST \/ DAST \/ image\) \| absent \/ absent \/ absent \|/,
  );
  assert.match(result.out, /\| Renovate rules \/ managers \/ groups \| absent \|/);
  assert.match(result.err, /renovate\.json/);
  assert.match(result.err, /security\/sast\/allowlist\.yaml/);

  const json = JSON.parse(run(['--json', '--rev', 'HEAD~1']).out);
  assert.equal(json.renovate, null);
  assert.equal(json.security.sastAllowlistEntries, null);

  // The CONTROL: once the inputs exist, they are counted and nothing is reported absent.
  const head = run(['--json']);
  assert.equal(head.err, '');
  const metrics = JSON.parse(head.out);
  assert.deepEqual(metrics.missingInputs, []);
  assert.equal(metrics.security.imageAllowlistEntries, 2);
  assert.equal(metrics.renovate.groups, 1);
});

test('an input that exists but does not parse fails the run', () => {
  write('renovate.json', '{ not json');
  git('commit', '-q', '-am', 'broken');
  try {
    const result = run([]);
    assert.equal(result.code, 1);
    assert.match(result.err, /renovate\.json does not parse/);
    assert.equal(result.out, '', 'a failed count prints no column');
  } finally {
    git('reset', '-q', '--hard', 'HEAD~1');
  }
});

test('a CLAUDE.md that predates the Gates section is reported, not called absent', () => {
  git('rm', '-q', 'AGENTS.md');
  write('CLAUDE.md', '# instructions\n\n## Commands\n\n- **not a gate**\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'pre-gates layout');
  try {
    const result = run([]);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /\| Instruction file \| `CLAUDE\.md`: 5 lines, no Gates section \|/);
    assert.doesNotMatch(result.err, /CLAUDE\.md/);
  } finally {
    git('reset', '-q', '--hard', 'HEAD~1');
  }
});

test('unrecognised and malformed arguments are rejected with exit 2, before any count', () => {
  for (const argv of [['--jsno'], ['--root'], ['--root', '--json'], ['--rev'], ['extra']]) {
    const result = run(argv);
    assert.equal(result.code, 2, `${argv.join(' ')} must be rejected`);
    assert.equal(result.out, '', `${argv.join(' ')} must print no column`);
  }
  assert.equal(run(['--rev', 'no-such-ref']).code, 1);
});

test('--help prints usage and counts nothing; usage names every flag', () => {
  for (const flag of ['--help', '-h']) {
    const result = run([flag]);
    assert.equal(result.code, 0);
    assert.equal(result.out, USAGE);
  }
  assert.deepEqual(usageNamesEveryFlag(USAGE, ['--json', '--rev', '--root', '--append-log', '--help']), []);
});

test('the column keeps three-digit feature numbers and names a reused number', () => {
  const column = run([]).out;
  assert.match(column, /\| Features \| 3 \(numbered to 002; 002 used twice\) \|/);
  assert.match(column, /\| Constitution \| 3 lines, v1\.1\.0, 1 amendments \|/);
  assert.match(column, /\| Instruction file \| `AGENTS\.md`: 6 lines, 2 gates \|/);
});

test('static counts: lines, test files and test declarations', () => {
  assert.equal(lineCountOf(''), 0);
  assert.equal(lineCountOf('a\n'), 1);
  assert.equal(lineCountOf('a\nb'), 2);

  assert.ok(isTest('scripts/__tests__/x.test.mjs'));
  assert.ok(isTest('backend/mc-service/tests/integration/a.rs'));
  assert.ok(isTest('agents/x/test_thing.py'));
  assert.ok(isTest('frontend/app/e2e/login.yaml'));
  assert.ok(!isTest('backend/src/lib.rs'));
  assert.ok(!isTest('scripts/latest.mjs'));

  const metrics = countMetrics(readRevision(repo));
  assert.equal(metrics.code.testCases.jsTs, 2);
  assert.equal(metrics.code.testCases.rust, 1);
  assert.equal(
    metrics.documentation.lines,
    2 + 3 + 6 + 3,
    'docs/a.md counts its unterminated line',
  );
  assert.match(renderColumn(metrics), /^\| Measure \| \d{4}-\d{2}-\d{2} \|$/m);
});

// ── --append-log: the script writes the log column itself (item #1133) ────────────────────────
//
// A pasted column has the same failure mode as a hand-counted one: BELAY measured the copying step
// as causing as much of the 4.5% hand-count gap as the counting did. These tests pin what makes the
// written column trustworthy: date order, never a second column for one commit, a script version on
// every column, and no column at all from a shallow clone (its commit count is wrong).

const LOG_START = '<!-- metrics-log:start -->';
const LOG_END = '<!-- metrics-log:end -->';
const LOG_DOC = (table) =>
  ['# Doc', '', 'Before the log.', '', LOG_START, ...table, LOG_END, '', 'After the log.', ''].join(
    '\n',
  );

const fixtureGit = (dir, args, env = process.env) =>
  execFileSync(
    'git',
    [
      '-C',
      dir,
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { encoding: 'utf8', env },
  ).trim();

/** A throwaway repository whose commits carry the given committer dates (YYYY-MM-DD). */
const makeDatedRepo = (dates) => {
  const dir = mkdtempSync(join(tmpdir(), 'count-repo-metrics-dated-'));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  dates.forEach((date, i) => {
    writeFileSync(join(dir, 'docs', `n${i}.md`), `note ${i}\n`);
    const stamp = `${date}T12:00:00+00:00`;
    const env = { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp };
    fixtureGit(dir, ['add', '-A'], env);
    fixtureGit(dir, ['commit', '-q', '-m', `c${i}`], env);
  });
  return dir;
};

const runIn = (dir, argv, extra = {}) => {
  const out = [];
  const err = [];
  const code = main(argv, {
    cwd: dir,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ...extra,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
};

const headerOf = (text) =>
  text
    .slice(text.indexOf(LOG_START) + LOG_START.length, text.indexOf(LOG_END))
    .trim()
    .split('\n')[0];
const rowOf = (text, label) => text.split('\n').find((line) => line.startsWith(`| ${label} |`)) ?? '';

test('scriptVersion names the blob, marks +dirty for an uncommitted edit, untracked when new', () => {
  const dir = mkdtempSync(join(tmpdir(), 'count-repo-metrics-version-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    const script = join(dir, 'tools', 'counter.mjs');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, 'export {};\n');
    assert.equal(scriptVersion(script), 'untracked');
    fixtureGit(dir, ['add', '-A']);
    fixtureGit(dir, ['commit', '-q', '-m', 'add counter']);
    const blob = fixtureGit(dir, ['rev-parse', '--short=8', 'HEAD:tools/counter.mjs']);
    assert.equal(scriptVersion(script), blob, 'a committed, unedited script is its blob');
    writeFileSync(script, 'export const edited = 1;\n');
    assert.equal(scriptVersion(script), `${blob}+dirty`);
    fixtureGit(dir, ['add', '-A']); // staged is still not the committed version
    assert.equal(scriptVersion(script), `${blob}+dirty`);
    assert.equal(scriptVersion(join(tmpdir(), 'no-such-dir-crm', 'x.mjs')), 'untracked');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeLogColumn fills empty markers with a table, leaving every byte outside unchanged', () => {
  const merged = mergeLogColumn(LOG_DOC([]), {
    date: '2026-01-02',
    commit: 'aaaaaaaa',
    rows: [
      ['Method', 'm'],
      ['Commit', '`aaaaaaaa`'],
      ['Features', '1'],
    ],
  });
  assert.equal(
    merged,
    LOG_DOC([
      '| Measure | 2026-01-02 |',
      '| --- | --- |',
      '| Method | m |',
      '| Commit | `aaaaaaaa` |',
      '| Features | 1 |',
    ]),
  );
});

test('mergeLogColumn inserts in commit-date order and fills a new row with "not recorded"', () => {
  const doc = LOG_DOC([
    '| Measure | 2026-01-01 | 2026-03-01 |',
    '| --- | --- | --- |',
    '| Method | hand | script |',
    '| Commit | not recorded | `cccccccc` |',
    '| Features | 1 | 3 |',
  ]);
  const merged = mergeLogColumn(doc, {
    date: '2026-02-01',
    commit: 'bbbbbbbb',
    rows: [
      ['Method', 'script'],
      ['Script version', 'blob `1234abcd`'],
      ['Commit', '`bbbbbbbb`'],
      ['Features', '2'],
    ],
  });
  assert.equal(headerOf(merged), '| Measure | 2026-01-01 | 2026-02-01 | 2026-03-01 |');
  assert.equal(rowOf(merged, 'Features'), '| Features | 1 | 2 | 3 |');
  assert.equal(
    rowOf(merged, 'Script version'),
    '| Script version | not recorded | blob `1234abcd` | not recorded |',
  );
  const labels = merged
    .split('\n')
    .filter((line) => /^\| [A-Z]/.test(line))
    .map((line) => line.split(' | ')[0]);
  assert.deepEqual(labels, ['| Measure', '| Method', '| Script version', '| Commit', '| Features']);
  assert.ok(merged.startsWith('# Doc\n\nBefore the log.\n\n'));
  assert.ok(merged.endsWith(`${LOG_END}\n\nAfter the log.\n`));
});

test('mergeLogColumn orders a same-day back-fill before the commit that descends from it', () => {
  const doc = LOG_DOC(['| Measure | 2026-01-01 |', '| --- | --- |', '| Commit | `dddddddd` |']);
  const column = { date: '2026-01-01', commit: 'eeeeeeee', rows: [['Commit', '`eeeeeeee`']] };
  assert.equal(
    rowOf(mergeLogColumn(doc, column), 'Commit'),
    '| Commit | `dddddddd` | `eeeeeeee` |',
    'an unrelated same-day commit goes after',
  );
  const before = mergeLogColumn(doc, column, {
    isAncestor: (a, b) => a === 'eeeeeeee' && b === 'dddddddd',
  });
  assert.equal(rowOf(before, 'Commit'), '| Commit | `eeeeeeee` | `dddddddd` |');
});

test('mergeLogColumn refuses a commit already logged, and a document without both markers', () => {
  const doc = LOG_DOC(['| Measure | 2026-01-01 |', '| --- | --- |', '| Commit | `aaaaaaaa` |']);
  const column = { date: '2026-01-05', commit: 'aaaaaaaa', rows: [['Commit', '`aaaaaaaa`']] };
  assert.throws(() => mergeLogColumn(doc, column), /aaaaaaaa is already logged/);
  assert.throws(() => mergeLogColumn('# no markers\n', column), /metrics-log:start/);
  assert.throws(() => mergeLogColumn(`${LOG_END}\n${LOG_START}\n`, column), /metrics-log:start/);
});

test('--append-log writes the column in date order; a second run on one commit exits 1, changing nothing', () => {
  const dir = makeDatedRepo(['2026-01-01', '2026-02-01', '2026-03-01']);
  const log = `${dir}-log.md`;
  try {
    writeFileSync(log, LOG_DOC([]));
    const opts = { scriptPath: join(dir, 'counter.mjs'), today: '2026-04-01' }; // untracked there

    const head = runIn(dir, ['--append-log', log], opts);
    assert.equal(head.code, 0, head.err);
    assert.match(head.out, /logged [0-9a-f]{8} \(2026-03-01\)/);
    const first = readFileSync(log, 'utf8');
    assert.equal(headerOf(first), '| Measure | 2026-03-01 |');
    assert.equal(rowOf(first, 'Method'), '| Method | `scripts/count-repo-metrics.mjs` |');
    assert.equal(rowOf(first, 'Script version'), '| Script version | untracked |');

    const again = runIn(dir, ['--append-log', log], opts);
    assert.equal(again.code, 1);
    assert.match(again.err, /already logged/);
    assert.equal(again.out, '', 'a refused run prints no column');
    assert.equal(readFileSync(log, 'utf8'), first, 'a refused run must not touch the file');

    const backfill = runIn(dir, ['--rev', 'HEAD~2', '--append-log', log], opts);
    assert.equal(backfill.code, 0, backfill.err);
    const second = readFileSync(log, 'utf8');
    assert.equal(headerOf(second), '| Measure | 2026-01-01 | 2026-03-01 |');
    assert.match(
      rowOf(second, 'Method'),
      /\| `scripts\/count-repo-metrics\.mjs --rev [0-9a-f]{8}`, back-filled 2026-04-01 \| `scripts\/count-repo-metrics\.mjs` \|$/,
    );
    assert.equal(rowOf(second, 'Commits'), '| Commits | 1 | 3 |');

    assert.equal(runIn(dir, ['--rev', 'HEAD~1', '--append-log', log], opts).code, 0);
    assert.equal(
      headerOf(readFileSync(log, 'utf8')),
      '| Measure | 2026-01-01 | 2026-02-01 | 2026-03-01 |',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(log, { force: true });
  }
});

test('--append-log refuses a file without markers, or one it cannot read, with exit 1', () => {
  const log = join(tmpdir(), `count-repo-metrics-nomarkers-${process.pid}.md`);
  try {
    writeFileSync(log, '# no markers here\n');
    const result = run(['--append-log', log]);
    assert.equal(result.code, 1);
    assert.match(result.err, /metrics-log:start/);
    assert.equal(readFileSync(log, 'utf8'), '# no markers here\n');
    assert.equal(run(['--append-log', `${log}.missing`]).code, 1);
  } finally {
    rmSync(log, { force: true });
  }
});

test('a shallow clone reports commits as unavailable and refuses to log, naming why', () => {
  const origin = makeDatedRepo(['2026-01-01', '2026-02-01']);
  const shallow = `${origin}-shallow`;
  const log = `${origin}-log.md`;
  try {
    execFileSync('git', [
      'clone',
      '-q',
      '--depth',
      '1',
      `file://${origin.replace(/\\/g, '/')}`,
      shallow,
    ]);
    const counted = runIn(shallow, ['--json']);
    assert.equal(counted.code, 0, counted.err);
    const metrics = JSON.parse(counted.out);
    assert.equal(metrics.shallow, true);
    assert.equal(metrics.commits, null, 'a shallow clone must not report its truncated count');
    assert.match(runIn(shallow, []).out, /\| Commits \| unavailable \(shallow clone\) \|/);

    writeFileSync(log, LOG_DOC([]));
    const refused = runIn(shallow, ['--append-log', log]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /shallow clone/);
    assert.equal(readFileSync(log, 'utf8'), LOG_DOC([]));

    // The CONTROL: the full history logs.
    assert.equal(JSON.parse(runIn(origin, ['--json']).out).shallow, false);
    assert.equal(runIn(origin, ['--append-log', log]).code, 0);
  } finally {
    for (const path of [origin, shallow, log]) rmSync(path, { recursive: true, force: true });
  }
});

test('--append-log needs a value and does not combine with --json (exit 2, file untouched)', () => {
  const log = join(tmpdir(), `count-repo-metrics-args-${process.pid}.md`);
  try {
    writeFileSync(log, LOG_DOC([]));
    for (const argv of [['--append-log'], ['--json', '--append-log', log], ['--append-log', '--json']]) {
      const result = run(argv);
      assert.equal(result.code, 2, `${argv.join(' ')} must be rejected`);
      assert.equal(result.out, '');
    }
    assert.equal(readFileSync(log, 'utf8'), LOG_DOC([]));
  } finally {
    rmSync(log, { force: true });
  }
});

test('logColumn stamps the script version as a blob, keeping +dirty outside the code span', () => {
  const metrics = countMetrics(readRevision(repo));
  const stampOf = (version) =>
    Object.fromEntries(logColumn(metrics, { today: '2026-01-01', version }).rows)['Script version'];
  assert.equal(stampOf('1234abcd'), 'blob `1234abcd`');
  assert.equal(stampOf('1234abcd+dirty'), 'blob `1234abcd`+dirty');
  assert.equal(stampOf('untracked'), 'untracked');
  const rows = logColumn(metrics, { today: '2026-01-01', version: 'untracked' }).rows;
  assert.deepEqual(rows.slice(0, 3).map(([label]) => label), ['Method', 'Script version', 'Commit']);
});
