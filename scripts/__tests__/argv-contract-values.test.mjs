// Guards partitionArgsWithValues (feature 077) — the value-taking extension to the shared
// argument contract.
//
// The parent module's scope note said a value-taking flag "needs an explicit extension, not a
// clever inference". This is that extension, so its refusals are the thing worth testing: the
// inference it refuses to make is exactly what item #500 was about. A parser that guesses a
// missing value is a parser that acts on something the caller never typed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArgvError, partitionArgsWithValues, usageNamesEveryFlag } from '../lib/argv-contract.mjs';

const SPEC = { accepted: ['--json', '--selftest'], withValues: ['--dist', '--budget'], usage: 'usage: --dist <d> --budget <n> --json --selftest' };

test('reads a space-separated value', () => {
  const { values } = partitionArgsWithValues(['--dist', '/tmp/x'], SPEC);
  assert.equal(values.get('--dist'), '/tmp/x');
});

test('reads an equals-separated value', () => {
  const { values } = partitionArgsWithValues(['--dist=/tmp/x'], SPEC);
  assert.equal(values.get('--dist'), '/tmp/x');
});

test('keeps valueless flags valueless', () => {
  const { flags, values } = partitionArgsWithValues(['--json'], SPEC);
  assert.ok(flags.has('--json'));
  assert.equal(values.size, 0);
});

test('mixes both kinds', () => {
  const { flags, values } = partitionArgsWithValues(['--dist', '/d', '--budget=10', '--json'], SPEC);
  assert.equal(values.get('--dist'), '/d');
  assert.equal(values.get('--budget'), '10');
  assert.ok(flags.has('--json'));
});

test('REFUSES an unrecognised flag', () => {
  assert.throws(() => partitionArgsWithValues(['--dry_run'], SPEC), ArgvError);
});

test('REFUSES a value-taking flag at the end of argv', () => {
  // `--budget` with nothing after it is a typo. Defaulting it would run the gate against a
  // number the caller never chose.
  assert.throws(() => partitionArgsWithValues(['--budget'], SPEC), ArgvError);
});

test('REFUSES a flag-shaped value', () => {
  // `--budget --json` means the caller lost a value. Reading `--json` as the budget is how a
  // gate ends up asserting against NaN and reporting a pass.
  assert.throws(() => partitionArgsWithValues(['--budget', '--json'], SPEC), ArgvError);
});

test('REFUSES an empty equals value', () => {
  assert.throws(() => partitionArgsWithValues(['--dist='], SPEC), ArgvError);
});

test('REFUSES a value handed to a valueless flag', () => {
  assert.throws(() => partitionArgsWithValues(['--json=1'], SPEC), ArgvError);
});

test('REFUSES a surplus positional', () => {
  assert.throws(() => partitionArgsWithValues(['extra'], SPEC), ArgvError);
});

test('allows positionals up to the declared maximum', () => {
  const { positionals } = partitionArgsWithValues(['one'], { ...SPEC, maxPositionals: 1 });
  assert.deepEqual(positionals, ['one']);
});

test('near-miss spellings are refused, not read as positionals', () => {
  for (const bad of ['-dist', '--dists', '--Dist']) {
    assert.throws(() => partitionArgsWithValues([bad, '/tmp/x'], SPEC), ArgvError, bad);
  }
});

test('the usage string names every flag it accepts', () => {
  assert.deepEqual(usageNamesEveryFlag(SPEC.usage, [...SPEC.accepted, ...SPEC.withValues]), []);
});
