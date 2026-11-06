#!/usr/bin/env node
// Measures one page through a running server, for SC-002's same-machine comparison (research R14).
// The figures are ratios for that comparison, not capacity numbers.
import { readFileSync } from 'node:fs';
import { ArgvError, dieOnArgvError, partitionArgsWithValues, wantsHelp } from '../../../scripts/lib/argv-contract.mjs';

const USAGE = [
  'usage: node measure-page-latency.mjs --url <url> [--requests 300] [--concurrency 10] [--pid <server pid>]',
  '',
  '  --url <url>           the page to request',
  '  --requests <n>        total requests (default 300)',
  '  --concurrency <n>     parallel workers (default 10)',
  '  --pid <pid>           server process, to report its resident memory before and after',
  '  --help                print this and exit',
].join('\n');

const argv = process.argv.slice(2);
if (wantsHelp(argv)) {
  console.log(USAGE);
  process.exit(0);
}

let parsed;
try {
  parsed = partitionArgsWithValues(argv, {
    withValues: ['--url', '--requests', '--concurrency', '--pid'],
    usage: USAGE,
  });
} catch (err) {
  if (!(err instanceof ArgvError)) throw err;
  dieOnArgvError(err);
}

const url = parsed.values.get('--url');
const requests = Number(parsed.values.get('--requests') ?? 300);
const concurrency = Number(parsed.values.get('--concurrency') ?? 10);
const pid = parsed.values.get('--pid');
if (!url || !Number.isInteger(requests) || requests < 1 || !Number.isInteger(concurrency) || concurrency < 1) {
  console.error(USAGE);
  process.exit(2);
}

const PAGE_SIZE_BYTES = 4096;
const BYTES_PER_MB = 1048576;
const residentMb = () =>
  pid
    ? Math.round((Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * PAGE_SIZE_BYTES) / BYTES_PER_MB)
    : null;

const durations = [];
let started = 0;
let serverErrors = 0;

async function worker() {
  while (started < requests) {
    started += 1;
    const t0 = performance.now();
    const res = await fetch(url);
    await res.arrayBuffer();
    if (res.status >= 500) serverErrors += 1;
    durations.push(performance.now() - t0);
  }
}

const rssBeforeMB = residentMb();
const t0 = performance.now();
await Promise.all(Array.from({ length: concurrency }, worker));
const elapsedSeconds = (performance.now() - t0) / 1000;
durations.sort((a, b) => a - b);

console.log(
  JSON.stringify({
    url,
    requests,
    concurrency,
    p50: Number(durations[requests >> 1].toFixed(1)),
    p95: Number(durations[Math.floor(requests * 0.95)].toFixed(1)),
    rps: Number((requests / elapsedSeconds).toFixed(1)),
    serverErrors,
    rssBeforeMB,
    rssAfterMB: residentMb(),
  }),
);
