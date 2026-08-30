#!/usr/bin/env node
// Item #311 — the weekly Renovate health digest.
//
// WHY THIS EXISTS. Renovate's failure mode on this forge is ABSENCE, and absence reads as "nothing
// to do": a channel whose toolchain is missing dies to one suppressed WARN line, for ever (#218); a
// surviving merged branch turns a dashboard tick into an empty PR and a wasted ~35-minute CI cycle
// (#290); open PRs silently eat next week's prConcurrentLimit; and a pending stability-days is
// indistinguishable from a dead one without going and looking (#298). Each of those was discovered
// by incident, sessions after it started. This job goes and looks, once a week, and writes what it
// found where the operator already reads.
//
// DESIGN, inherited from check-lockfile-refresh.mjs (the proven pattern):
//   - comment-only, ALWAYS exit 0 — a weekly red trains people to ignore it; the comment IS the report
//   - always comments, even when healthy (one line) — so silence means the JOB died, which is itself
//     the signal; absence must never read as health, that being the root fault this digest exists for
//   - self-stopping: no-ops once item #311 is closed. CLOSING #311 IS THE KILL SWITCH.
//   - reads the Dependency Dashboard (#29); NEVER writes it — ticking is the only sanctioned
//     interaction with #29 and this script does not tick
//
// Usage:
//   node scripts/renovate-health.mjs             # post the digest to item #311
//   node scripts/renovate-health.mjs --dry-run   # exercise every read + render, post nothing

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ITEM = 311; // the digest's home — close it to stop the digest
const DASHBOARD = 29; // Renovate's Dependency Dashboard — READ ONLY here
const STABILITY_CONTEXT = 'renovate/stability-days';
const BRANCH_PREFIX = 'renovate/';

// ── Pure logic (unit-tested in __tests__/renovate-health.test.mjs) ───────────

/**
 * The `## Repository problems` section of the dashboard body, warnings only. This is the ONE place
 * a dead channel is visible at all — Renovate suppresses the underlying rejection to a single WARN
 * line here and the channel then simply never appears (§5 of the runbook, item #218).
 */
export function parseRepositoryProblems(body) {
  const text = String(body ?? '');
  const m = text.match(/^##\s+Repository problems\s*$([\s\S]*?)(?=^##\s|\n*$(?![\s\S]))/im);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter((l) => l.includes('WARN') || l.includes('ERROR'));
}

/**
 * Classify every renovate/* branch by ancestry against main.
 *   ancestor + open PR   → an EMPTY PR (the #288 shape: a stale branch reused verbatim)
 *   ancestor + no PR     → a stale ref (the #290 class — the repo setting covers UI merges only)
 *   not ancestor         → active pending work (normal)
 *   ancestry unanswerable→ reported, never dropped — a guard that silently skips what it cannot
 *                          read is the fault this file exists to prevent
 */
export function classifyRenovateBranches(branches, openPrHeads, isAncestor) {
  const out = { emptyPr: [], stale: [], active: [], unknown: [] };
  for (const b of branches) {
    if (!b.startsWith(BRANCH_PREFIX)) continue;
    const anc = isAncestor(b);
    if (anc === null || anc === undefined) out.unknown.push(b);
    else if (anc && openPrHeads.has(b)) out.emptyPr.push(b);
    else if (anc) out.stale.push(b);
    else out.active.push(b);
  }
  return out;
}

/** Open Renovate PRs consume prConcurrentLimit — leaving four unmerged caps the next window at one. */
export function budget(config, openRenovatePrs) {
  const limit = Number(config?.prConcurrentLimit ?? 0);
  const open = openRenovatePrs.length;
  return { limit, open, headroom: Math.max(0, limit - open) };
}

/** One row per open Renovate PR: its stability-days state, or `absent` when no such context exists. */
export function stabilityRows(prs, statusesBySha) {
  return prs.map((pr) => {
    const statuses = statusesBySha[pr.head?.sha] ?? [];
    const st = statuses.find((s) => s.context === STABILITY_CONTEXT);
    return {
      number: pr.number,
      title: pr.title,
      created_at: pr.created_at,
      stability: st ? (st.status ?? st.state ?? 'unknown') : 'absent',
    };
  });
}

export function buildDigest({ problems, branches, budgetInfo, rows }) {
  const anomalies =
    problems.length + branches.emptyPr.length + branches.stale.length + branches.unknown.length;
  const lines = ['### Weekly Renovate health digest', ''];

  if (anomalies === 0) {
    lines.push('✅ **Healthy.** No repository problems, no empty-PR or stale `renovate/*` branches.');
  }

  if (problems.length) {
    lines.push('❌ **Repository problems on the dashboard** — a channel may be dead (runbook §5):', '');
    for (const p of problems) lines.push(`- ${p}`);
    lines.push('');
  }
  if (branches.emptyPr.length) {
    lines.push(
      `⚠️ **Empty-PR branches** (ancestor of \`main\` with an open PR — the #288 shape; leave for autoclose, cancel the CI runs if in the way — runbook §4): ${branches.emptyPr.map((b) => `\`${b}\``).join(', ')}`,
      '',
    );
  }
  if (branches.stale.length) {
    lines.push(
      `⚠️ **Stale refs** (ancestor of \`main\`, no open PR — the #290 class; the repo setting covers UI merges only): ${branches.stale.map((b) => `\`${b}\``).join(', ')}`,
      '',
    );
  }
  if (branches.unknown.length) {
    lines.push(
      `⚠️ **Ancestry unanswerable** (shallow clone? deleted upstream mid-run?): ${branches.unknown.map((b) => `\`${b}\``).join(', ')}`,
      '',
    );
  }

  lines.push(
    '',
    `**Budget**: ${budgetInfo.open} open Renovate PR(s) of \`prConcurrentLimit: ${budgetInfo.limit}\` — headroom **${budgetInfo.headroom}** for the next window. Merging promptly is a throughput lever (runbook §1).`,
  );
  if (branches.active.length) {
    lines.push('', `Active pending branches: ${branches.active.map((b) => `\`${b}\``).join(', ')}`);
  }

  if (rows.length) {
    lines.push('', '**Open Renovate PRs and their `stability-days` state** (the item #298 observation):', '');
    lines.push('| PR | created | stability-days |', '|---|---|---|');
    for (const r of rows) lines.push(`| #${r.number} — ${r.title} | \`${r.created_at}\` | ${r.stability} |`);
  }

  lines.push('', '_`scripts/renovate-health.mjs` — close item #311 to stop this digest._');
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

/** Renovate-authored: renovate/* head, or the Mend footer for reused refs/pull heads. */
function isRenovatePr(pr) {
  return (
    String(pr?.head?.ref ?? '').startsWith(BRANCH_PREFIX) ||
    String(pr?.body ?? '').includes('Mend Renovate')
  );
}

function gitIsAncestor(branch) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', `origin/${branch}`, 'origin/main'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    if (err?.status === 1) return false; // a real answer: not an ancestor
    return null; // could not answer (missing ref, shallow clone) — reported, never dropped
  }
}

async function main() {
  const token = process.env.CI_DIGEST_TOKEN?.trim() || process.env.MCM_FORGE_ISSUE_TOKEN?.trim();
  if (!token) {
    // Loudly, but exit 0: an absent Actions secret must not read as a verdict.
    console.error('[renovate-health] no CI_DIGEST_TOKEN — cannot read the forge or comment. Exiting 0 WITHOUT a digest.');
    return;
  }
  const server = (process.env.GITHUB_SERVER_URL ?? '').replace(/\/$/, '');
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? 'jumbleknot/mcm').split('/');
  const call = api(`${server}/api/v1`, token);

  const item = await call('GET', `/repos/${owner}/${repo}/issues/${ITEM}`);
  if (item.state !== 'open') {
    console.log(`[renovate-health] item #${ITEM} is ${item.state} — the digest is switched off. Exiting 0.`);
    return;
  }

  const config = JSON.parse(readFileSync(resolve(REPO_ROOT, 'renovate.json'), 'utf8'));
  const dashboard = await call('GET', `/repos/${owner}/${repo}/issues/${DASHBOARD}`);
  const problems = parseRepositoryProblems(dashboard.body);

  const openPrs = (await call('GET', `/repos/${owner}/${repo}/pulls?state=open&limit=50`)).filter(isRenovatePr);
  const openPrHeads = new Set(openPrs.map((p) => p.head?.ref).filter(Boolean));

  const branchNames = (await call('GET', `/repos/${owner}/${repo}/branches?limit=50`)).map((b) => b.name);
  const branches = classifyRenovateBranches(branchNames, openPrHeads, gitIsAncestor);

  const statusesBySha = {};
  for (const pr of openPrs) {
    const sha = pr.head?.sha;
    if (!sha) continue;
    // The combined-status endpoint carries every context on the sha; stability-days included.
    statusesBySha[sha] = (await call('GET', `/repos/${owner}/${repo}/commits/${sha}/status`)).statuses ?? [];
  }
  const rows = stabilityRows(openPrs, statusesBySha);
  const body = buildDigest({ problems, branches, budgetInfo: budget(config, openPrs), rows });

  console.log(`[renovate-health] problems=${problems.length} emptyPr=${branches.emptyPr.length} stale=${branches.stale.length} unknown=${branches.unknown.length} openPrs=${openPrs.length}`);
  if (process.argv.includes('--dry-run')) {
    // Exercises every read and the whole render path, and posts nothing — so the check can be
    // proven working now rather than discovered broken on a Friday.
    console.log('\n──── digest that WOULD be posted ────\n' + body + '\n─────────────────────────────────────');
    return;
  }
  await call('POST', `/repos/${owner}/${repo}/issues/${ITEM}/comments`, { body });
  console.log(`[renovate-health] commented on item #${ITEM}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // Still exit 0 — see the header. A broken digest must not present as a failed build.
    console.error(`[renovate-health] FAILED to produce a digest: ${err.message}`);
  });
}
