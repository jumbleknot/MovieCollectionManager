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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { usageNamesEveryFlag } from '../lib/argv-contract.mjs';
import {
  USAGE,
  countMetrics,
  isTest,
  lineCountOf,
  main,
  readRevision,
  renderColumn,
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
  assert.deepEqual(usageNamesEveryFlag(USAGE, ['--json', '--rev', '--root', '--help']), []);
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
