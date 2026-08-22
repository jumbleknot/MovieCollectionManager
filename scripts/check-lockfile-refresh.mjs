#!/usr/bin/env node
// Item #218 — did the lockfile refresh fire UNAIDED this week?
//
// WHY THIS IS A SCRIPT AND NOT A COMMENT. Item #184 sat for a week on "close this when a
// lock-file-maintenance PR appears", and the PR had already appeared and merged — nobody looked. The
// same comment then recorded a wrong conclusion drawn from a dry run. A note telling a human to check
// later is exactly the mechanism that failed, twice. This checks, and writes the verdict where the
// decision gets made.
//
// THE LOAD-BEARING DISTINCTION IS *UNAIDED* vs *AIDED*. A lock-file PR existing proves nothing on its
// own: PR #199 existed, and it came from a human ticking `unlimit-branch` on the Dependency
// Dashboard. The mechanical tell is WHEN the PR was created. renovate@44's
// `workers/repository/update/branch/index.js:244` returns `not-scheduled` BEFORE creating a branch,
// and the only thing that bypasses it is `dependencyDashboardCheck`. So a PR created OUTSIDE the
// permitted window cannot have come from the schedule — it was forced. Reading the dashboard's tick
// directly would NOT work: Renovate rewrites that issue on every run, so by the time this runs the
// tick that mattered is gone.
//
// Comment-only, always exit 0. A weekly red on a knowingly-open item trains people to ignore it; the
// comment on the item is the report, and it stops by itself when the item is closed.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ITEM = 218;
const MEND_FOOTER = 'Mend Renovate CLI';
const TITLE_RE = /lock file maintenance/i;
const BRANCH_RE = /^renovate\/lock-file-maintenance/;

/** Expand a cron field over `min..max`. `*`, `N`, `A-B` and comma lists only — anything else throws. */
function expandCronField(field, min, max) {
  const out = new Set();
  for (const part of String(field).split(',')) {
    if (part === '*') for (let v = min; v <= max; v += 1) out.add(v);
    else if (/^\d+$/.test(part)) out.add(Number(part));
    else if (/^\d+-\d+$/.test(part)) {
      const [lo, hi] = part.split('-').map(Number);
      for (let v = lo; v <= hi; v += 1) out.add(v);
    } else throw new Error(`unsupported cron field '${part}' — extend expandCronField before using it`);
  }
  return out;
}

/**
 * The permitted branch-creation window, DERIVED from renovate.json rather than restated here — if the
 * schedule moves, this check moves with it. `lockFileMaintenance`'s own schedule wins over the
 * inherited top-level one, which is how Renovate resolves it (and is why that key is load-bearing).
 */
export function parseWindow(config) {
  const schedules = config?.lockFileMaintenance?.schedule ?? config?.schedule ?? [];
  const hours = new Set();
  const dow = new Set();
  for (const expr of schedules) {
    const f = String(expr).trim().split(/\s+/);
    if (f.length !== 5) throw new Error(`expected a 5-field cron, got '${expr}'`);
    for (const h of expandCronField(f[1], 0, 23)) hours.add(h);
    for (const d of expandCronField(f[4], 0, 6)) dow.add(d);
  }
  return { timezone: config?.timezone ?? 'UTC', hours, dow };
}

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Is `iso` inside the window, in the window's OWN timezone?
 *
 * Evaluated with `Intl` against the specific instant, deliberately: unlike the workflow guard — which
 * hard-codes both offsets because it must check both halves of the year at once — this asks about one
 * real timestamp, so the offset actually in force at that moment is the correct one.
 */
export function inWindow(iso, window) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: window.timezone, hourCycle: 'h23', hour: '2-digit', weekday: 'short',
  }).formatToParts(new Date(iso));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const day = DOW[parts.find((p) => p.type === 'weekday')?.value];
  return window.hours.has(hour) && window.dow.has(day);
}

/** A Renovate-authored lockFileMaintenance PR — both signals, because either alone is wrong. */
export function isLockFilePr(pr) {
  const byBranch = BRANCH_RE.test(pr?.head?.ref ?? '');
  // A merged PR reports head.ref as refs/pull/N/head once its branch is deleted (measured on #199),
  // so the branch name alone would miss the merged case — which is the one we most want to catch.
  const byTitle = TITLE_RE.test(pr?.title ?? '');
  if (!byBranch && !byTitle) return false;
  // The footer is what separates the bot from a human reconstructing the same PR by hand. #199 had a
  // hand-made predecessor shape in this repo's history; certifying one of those would be the whole
  // failure repeated.
  return String(pr?.body ?? '').includes(MEND_FOOTER);
}

export function classify({ branches = [], pulls = [], window, since }) {
  const candidates = pulls
    .filter(isLockFilePr)
    .filter((p) => p.created_at >= since)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const unaided = candidates.filter((p) => inWindow(p.created_at, window));
  const branchNames = branches.filter((b) => BRANCH_RE.test(b));

  if (unaided.length) return { verdict: 'UNAIDED', pr: unaided.at(-1), branches: branchNames };
  if (candidates.length) return { verdict: 'AIDED', pr: candidates.at(-1), branches: branchNames };
  return { verdict: 'STILL_STARVED', pr: null, branches: branchNames };
}

/** Most recent instant at or before `now` that begins a window day, as an ISO string. */
export function periodStart(now, window) {
  const d = new Date(now);
  for (let back = 0; back <= 8; back += 1) {
    const probe = new Date(d.getTime() - back * 86400000);
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: window.timezone, weekday: 'short' })
      .formatToParts(probe).find((p) => p.type === 'weekday')?.value;
    if (window.dow.has(DOW[wd])) return new Date(Date.UTC(
      probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate(),
    )).toISOString();
  }
  return new Date(d.getTime() - 8 * 86400000).toISOString();
}

export function buildComment(result, { since, window }) {
  const head = {
    UNAIDED: '### ✅ The lockfile refresh fired UNAIDED',
    AIDED: '### ⚠️ A lock-file PR exists, but it was FORCED — this is not the criterion',
    STILL_STARVED: '### ❌ Still starved — no lock-file-maintenance PR this period',
  }[result.verdict];

  const lines = [head, '', `Checked automatically by \`scripts/check-lockfile-refresh.mjs\`. Period examined: since \`${since}\`.`, ''];

  if (result.pr) {
    lines.push(`| | |`, `|---|---|`,
      `| PR | #${result.pr.number} — ${result.pr.title} |`,
      `| Created | \`${result.pr.created_at}\` |`,
      `| Head | \`${result.pr.head?.ref}\` |`,
      `| Inside the permitted window? | **${result.verdict === 'UNAIDED' ? 'yes' : 'no'}** (\`${[...window.hours].sort((a, b) => a - b).join(',')}\`h, dow \`${[...window.dow].join(',')}\` @ ${window.timezone}) |`, '');
  }

  lines.push(`Branches present: ${result.branches.length ? result.branches.map((b) => `\`${b}\``).join(', ') : '_none_'}`, '');

  if (result.verdict === 'UNAIDED') {
    lines.push(
      'The PR was created **inside** the permitted branch-creation window, so it came from the schedule',
      'rather than from a dashboard tick — `update/branch/index.js:244` returns `not-scheduled` before',
      'branch creation, and only `dependencyDashboardCheck` bypasses it.',
      '',
      '**This item\'s remaining criterion is met.** Verify the PR is genuinely a lockfile refresh, then',
      'close this item — the check no-ops once it is closed.');
  } else if (result.verdict === 'AIDED') {
    lines.push(
      'Created **outside** the window, which the schedule alone cannot do — so a dashboard tick (or a',
      'dispatch) forced it. This is the exact shape of PR #199, and it does **not** demonstrate that the',
      'configured cadence works. The item stays open.');
  } else {
    lines.push(
      'The `prPriority` rule and the widened `prHourlyLimit` did **not** produce a refresh this period.',
      'That means the diagnosis in this item has a gap — it should be reopened as a question, not',
      'explained away. Worth checking first: whether the in-window run happened at all, and whether the',
      'two rolling groups still consumed the budget ahead of it.');
  }

  return lines.join('\n');
}

// ── I/O ──────────────────────────────────────────────────────────────────────

const api = (base, token) => async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `token ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

async function main() {
  const token = process.env.CI_DIGEST_TOKEN?.trim() || process.env.MCM_FORGE_ISSUE_TOKEN?.trim();
  if (!token) {
    // Loudly, but exit 0: an absent Actions secret must not read as a verdict.
    console.error('[lockfile-refresh-check] no CI_DIGEST_TOKEN — cannot read the forge or comment. Exiting 0 WITHOUT a verdict.');
    return;
  }
  const server = (process.env.GITHUB_SERVER_URL ?? '').replace(/\/$/, '');
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? 'jumbleknot/mcm').split('/');
  const call = api(`${server}/api/v1`, token);

  const item = await call('GET', `/repos/${owner}/${repo}/issues/${ITEM}`);
  if (item.state !== 'open') {
    console.log(`[lockfile-refresh-check] item #${ITEM} is ${item.state} — nothing to verify. Exiting 0.`);
    return;
  }

  const config = JSON.parse(readFileSync(resolve(REPO_ROOT, 'renovate.json'), 'utf8'));
  const window = parseWindow(config);
  const now = process.env.LOCKFILE_CHECK_NOW ?? new Date().toISOString();
  const since = periodStart(now, window);

  const branches = (await call('GET', `/repos/${owner}/${repo}/branches?limit=50`)).map((b) => b.name);
  const pulls = await call('GET', `/repos/${owner}/${repo}/pulls?state=all&limit=50`);

  const result = classify({ branches, pulls, window, since });
  console.log(`[lockfile-refresh-check] verdict=${result.verdict} pr=${result.pr?.number ?? '-'} since=${since}`);

  const body = buildComment(result, { since, window });
  if (process.argv.includes('--dry-run')) {
    // Exercises every read and the whole verdict path, and posts nothing. This exists because the
    // alternative is discovering on a Friday that the check itself is broken — the failure mode the
    // check was written to end.
    console.log('\n──── comment that WOULD be posted ────\n' + body + '\n──────────────────────────────────────');
    return;
  }
  await call('POST', `/repos/${owner}/${repo}/issues/${ITEM}/comments`, { body });
  console.log(`[lockfile-refresh-check] commented on item #${ITEM}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // Still exit 0 — see the header. A broken check must not present as a failed build.
    console.error(`[lockfile-refresh-check] FAILED to produce a verdict: ${err.message}`);
  });
}
