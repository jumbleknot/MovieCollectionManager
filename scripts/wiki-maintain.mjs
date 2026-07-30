#!/usr/bin/env node
// OpenWiki maintenance orchestrator — feature 044.
//
// Usage:
//   node scripts/wiki-maintain.mjs --plan [--since <ref>] [--json]
//   node scripts/wiki-maintain.mjs --execute [--max-slices <n>] [--dry-run]
//   node scripts/wiki-maintain.mjs --selftest
//
// Exit codes: 0 planned / all attempted slices verified / nothing to do · 1 a slice failed
// verification · 2 bad usage, unreadable state, or a missing credential on --execute · 3 stopped at
// the budget ceiling with work outstanding — NOT a failure.
//
// Contract: specs/044-openwiki-automation-migration/contracts/cli-contracts.md (C1, C6)
// Entities: specs/044-openwiki-automation-migration/data-model.md (E1–E3)
//
// ── The one thing to understand before changing this file ───────────────────────────────────────
// The generator has NO programmatic scoping surface (research R2): `openwiki code --update <message>`
// is the entire interface — no --pages, no --scope, no --max-pages. A slice is therefore an
// INSTRUCTION TO A MODEL, not a constraint on a process, and nothing stops the generator ignoring it.
// Consequently:
//   * Success is judged by pages that landed in the WORKING TREE, plus bundle conformance, plus
//     every written path being permitted by openwiki/policy.yaml.
//   * The generator's exit status is NEVER consulted. Feature 043 measured the failure this exists to
//     end: 12 minutes of paid work, one index.md written, exit 0, reported as success.
//   * The generator reports no token or cost data either (research R1), which is why the budget is
//     pages + wall-clock and why neither is a monetary bound.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The run record lives beside the bundle it describes, and is COMMITTED: runners are ephemeral, and
// FR-012 requires the marker to advance even on a run that creates no proposal.
export const STATE_FILE = 'openwiki/.maintenance-state.json';

// Exactly the three outcomes FR-017 requires distinguishing. A credential, capacity or generator
// failure must never be classified as `nothing-to-do` — that would make the cheap path look reachable
// while the work silently never happened.
export const RUN_OUTCOMES = Object.freeze(['nothing-to-do', 'completed', 'failed']);

const EMPTY_RECORD = Object.freeze({
  coveredCommit: null,
  coveredAt: null,
  lastOutcome: null,
  backlog: [],
  proposal: null,
  lastRunBudget: null,
});

const statePath = (root) => join(root, STATE_FILE);

/**
 * Read the run record. An ABSENT file is legitimately "never covered" and reads as the empty record;
 * a PRESENT but malformed one is a hard error. Silently defaulting on corruption would either
 * re-cover history already covered (paid work repeated) or certify history that was never examined.
 */
export function readRunRecord(root = REPO_ROOT) {
  const p = statePath(root);
  if (!existsSync(p)) return { ...EMPTY_RECORD };

  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${STATE_FILE}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${STATE_FILE} does not parse: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${STATE_FILE} must contain a JSON object, got ${Array.isArray(parsed) ? 'an array' : typeof parsed}`);
  }

  const record = { ...EMPTY_RECORD, ...parsed };
  assertRecordShape(record);
  return record;
}

/** Write the run record, validating first — an invalid record must never reach disk. */
export function writeRunRecord(root = REPO_ROOT, record = {}) {
  const merged = { ...EMPTY_RECORD, ...record };
  assertRecordShape(merged);
  const p = statePath(root);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

function assertRecordShape(record) {
  if (record.lastOutcome !== null && !RUN_OUTCOMES.includes(record.lastOutcome)) {
    throw new Error(`${STATE_FILE}: lastOutcome must be one of ${RUN_OUTCOMES.join(' | ')} (or null), got ${JSON.stringify(record.lastOutcome)}`);
  }
  if (record.coveredCommit !== null && typeof record.coveredCommit !== 'string') {
    throw new Error(`${STATE_FILE}: coveredCommit must be a commit string or null`);
  }
  if (!Array.isArray(record.backlog)) {
    throw new Error(`${STATE_FILE}: backlog must be an array of slices`);
  }
  if (record.proposal !== null && (typeof record.proposal !== 'object' || Array.isArray(record.proposal))) {
    throw new Error(`${STATE_FILE}: proposal must be an object or null`);
  }
}
