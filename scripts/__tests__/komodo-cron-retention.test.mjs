// infrastructure-as-code/backup/komodo-cron-retention.sql — the pg_cron job that keeps Komodo's
// scheduler history bounded (spec 084 FR-019d, research R8).
//
// Measured 2026-10-27: cron.job_run_details held 11.9 M rows (2,147 MB, ~89,000 a day from four
// DocumentDB jobs, two of them every 2 seconds) and NOTHING purged it, so Komodo's nightly dump was
// 2 GB of bookkeeping nobody reads. The backup excludes the table's data; this job stops the table
// itself from growing. The file is applied by hand (README), possibly more than once, so it must be
// idempotent and must touch nothing but that one table.
//
// Unit tier: the SQL is read as text. Applying it is the operator's step (T034).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SQL_PATH = resolve(REPO_ROOT, 'infrastructure-as-code/backup/komodo-cron-retention.sql');
const JOB = 'purge-cron-run-history';

/** The SQL without `--` comments, so prose in a comment can neither satisfy nor trip a check. */
const code = () => readFileSync(SQL_PATH, 'utf8').replace(/--[^\n]*/g, '');

/** Each cron.schedule('<name>', '<cron>', $$<command>$$) call. */
function schedules(sql) {
  return [...sql.matchAll(/cron\.schedule\s*\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*\$\$([\s\S]*?)\$\$\s*\)/g)]
    .map((m) => ({ index: m.index, name: m[1], cron: m[2], command: m[3].trim() }));
}

test('the purge job is scheduled hourly and deletes run history older than 3 days', () => {
  const jobs = schedules(code()).filter((j) => j.name === JOB);
  assert.equal(jobs.length, 1, `exactly one cron.schedule('${JOB}', …)`);
  const [job] = jobs;
  assert.match(job.cron, /^(\d{1,2} \* \* \* \*|@hourly)$/, `hourly, got '${job.cron}'`);
  assert.match(job.command, /^DELETE\s+FROM\s+cron\.job_run_details\s+WHERE\s+end_time\s*<\s*now\(\)\s*-\s*interval\s+'3 days'\s*;?$/i,
    job.command);
});

test('it is idempotent: the job is unscheduled if it exists, before it is scheduled', () => {
  const sql = code();
  const guard = sql.search(new RegExp(String.raw`cron\.unschedule\s*\(\s*jobid\s*\)\s+FROM\s+cron\.job\s+WHERE\s+jobname\s*=\s*'${JOB}'`, 'i'));
  assert.ok(guard >= 0, `no "SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = '${JOB}'" guard`);
  for (const job of schedules(sql)) assert.ok(guard < job.index, `cron.schedule('${job.name}') precedes its unschedule guard`);
  // A bare unschedule-by-name errors when the job does not exist yet, so the first apply would fail.
  assert.doesNotMatch(sql, /cron\.unschedule\s*\(\s*'/, 'unschedule by name fails on a first apply');
});

test('it touches no other table', () => {
  const sql = code();
  const writes = [...sql.matchAll(/\b(DELETE\s+FROM|UPDATE|INSERT\s+INTO|TRUNCATE(?:\s+TABLE)?|DROP\s+(?:TABLE|SCHEMA|EXTENSION)|ALTER\s+TABLE|VACUUM(?:\s+FULL)?)\s+([\w."]+)/gi)]
    .map((m) => `${m[1].replace(/\s+/g, ' ').toUpperCase()} ${m[2]}`);
  assert.deepEqual(writes, ['DELETE FROM cron.job_run_details'],
    'the only write is the scheduled delete (the one-off VACUUM FULL is an operator step, not this file)');
});
