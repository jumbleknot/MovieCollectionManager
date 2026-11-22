// Feature 105 US2 — output of the interactive commands (contracts/cli.md: fixed-width, ≤ 10 rows,
// `--json` for every row; host names redacted from every line, FR-021). T035.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactLine, renderTable } from '../lib/cc-usage/render-table.mjs';

const COLS = [
  { key: 'name', label: 'name' },
  { key: 'tokens', label: 'tokens', align: 'right' },
];
const rows = (n) => Array.from({ length: n }, (_, i) => ({ name: `row-${i}`, tokens: i * 1000 }));

test('fixed width: a header, aligned columns, numbers right-aligned with thousands separators', () => {
  const out = renderTable(rows(2), COLS).split('\n');
  assert.equal(out.length, 3);
  assert.match(out[0], /^name\s+tokens$/);
  assert.equal(new Set(out.map((l) => l.length)).size, 1, 'every line is the same width');
  assert.match(out[2], /row-1\s+1,000$/);
});

test('capped at 10 rows, with a "… N more" line', () => {
  const out = renderTable(rows(13), COLS).split('\n');
  assert.equal(out.length, 1 + 10 + 1);
  assert.equal(out.at(-1), '… 3 more');
});

test('--json returns every row', () => {
  const parsed = JSON.parse(renderTable(rows(13), COLS, { json: true }));
  assert.equal(parsed.length, 13);
  assert.deepEqual(parsed[12], { name: 'row-12', tokens: 12000 });
});

test('a tailnet host name in a value is redacted, in the table and in --json', () => {
  const r = [{ name: 'http://box.tail1234.ts.net:19040/x', tokens: 1 }];
  assert.doesNotMatch(renderTable(r, COLS), /tail1234/);
  assert.doesNotMatch(renderTable(r, COLS, { json: true }), /tail1234/);
});

test('a configured store host is redacted even when it is not a *.ts.net name', () => {
  const line = redactLine('fetch http://homelab.lan:19040/v_session_totals failed', { hosts: ['homelab.lan'] });
  assert.doesNotMatch(line, /homelab\.lan/);
  assert.match(line, /<store>/);
});

test('an empty result says so', () => {
  assert.equal(renderTable([], COLS), '(no rows)');
});
