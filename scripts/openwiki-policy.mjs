// Shared reader for openwiki/policy.yaml — feature 044 (data-model E4).
//
// Imported by BOTH consumers so the semantics cannot drift between them:
//   * scripts/check-openwiki-governance.mjs — the always-on gate (rules G1–G4, G12): does the policy
//     DECLARE a legal assignment for every documentation path?
//   * scripts/wiki-maintain.mjs — the maintenance run: which changed paths are coverage targets, and
//     did the generator write anywhere its declared policy forbids (FR-026e)?
//
// The gate checks the declaration; the run checks obedience. Both need the same answer to "which
// entry governs this path", and a second implementation of that would eventually disagree with the
// first — silently, in the direction of permitting a write.
//
// `node:` built-ins + `yaml` only. No network, no credential.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const POLICY_FILE = 'openwiki/policy.yaml';

/** The five declared states (FR-026b). Anything else is a G2 violation. */
export const POLICY_STATES = Object.freeze([
  'regenerate',
  'event-driven',
  'excluded',
  'never-written',
  'analyzable-not-covered',
]);

/** Only these two are coverage targets: a change to one may require the bundle to be updated. */
export const COVERAGE_POLICIES = Object.freeze(['regenerate', 'event-driven']);

export const ACTORS = Object.freeze(['agent', 'generator']);

/** The one place `actor: generator` is permitted (FR-026c). */
export const GENERATOR_SCOPE_PREFIX = 'openwiki/';

/**
 * Translate a policy glob to a RegExp.
 *
 * Supported, and deliberately no more: `**` crossing separators, `*` and `?` within one segment.
 * `**\/` matches ZERO OR MORE leading directories, which is why a single `**\/README.md` entry covers
 * both the root README and every nested one.
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 2;
        } else if (glob[i - 1] === '/') {
          re = re.replace(/\/$/, '') + '(?:/.*)?';
          i += 1;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+()[]{}^$|\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Load and compile the policy. FAIL-CLOSED: an absent or unparseable file throws. A missing policy
 * must never read as "everything is permitted" — that is the failure mode the whole file exists to
 * remove.
 */
export function loadPolicy(root) {
  const path = join(root, POLICY_FILE);
  if (!existsSync(path)) throw new Error(`${POLICY_FILE} is missing — the regeneration policy is a required artifact`);

  let parsed;
  try {
    parsed = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${POLICY_FILE} does not parse: ${err.message.split('\n')[0]}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.paths)) {
    throw new Error(`${POLICY_FILE} must be a mapping with a \`paths\` list`);
  }

  const entries = parsed.paths.map((raw, i) => {
    if (raw === null || typeof raw !== 'object' || typeof raw.glob !== 'string') {
      throw new Error(`${POLICY_FILE}: entry ${i} has no \`glob\``);
    }
    if ('coverage' in raw && typeof raw.coverage !== 'boolean') {
      throw new Error(`${POLICY_FILE}: entry \`${raw.glob}\` has a non-boolean \`coverage\``);
    }
    return {
      ...raw,
      matcher: globToRegExp(raw.glob),
      exceptionMatchers: (Array.isArray(raw.exceptions) ? raw.exceptions : []).map(globToRegExp),
    };
  });

  return { version: parsed.version ?? null, entries };
}

/**
 * How specific a glob is, as a tuple compared left to right:
 *   1. how many leading path segments are literal — i.e. how deeply the glob is ANCHORED
 *   2. how many literal (non-wildcard) characters it contains
 *   3. raw length, as a last resort
 *
 * Anchoring has to dominate, and getting this wrong is not academic: ranking by raw length alone made
 * `**\/README.md` (12 chars) outrank `.specify/**` (11), so a Spec Kit README — inside a tree declared
 * `excluded` — resolved to `regenerate` and the planner proposed writing a concept about it. "A rule
 * about THIS directory beats a rule about files anywhere" is the intuition; segment anchoring is its
 * mechanical form.
 */
function specificity(glob) {
  const segments = glob.split('/');
  let anchored = 0;
  for (const s of segments) {
    if (s.includes('*') || s.includes('?')) break;
    anchored++;
  }
  const literals = glob.replace(/[*?/]/g, '').length;
  return [anchored, literals, glob.length];
}

const moreSpecific = (a, b) => {
  const sa = specificity(a);
  const sb = specificity(b);
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] > sb[i];
  return false; // equal — keep the earlier declaration
};

/**
 * The entry governing `path`, or null when nothing classifies it (a G1 violation).
 *
 * Resolution is MOST-SPECIFIC-WINS, with ties broken in declaration order. That is what lets a broad
 * `openwiki/**` assignment coexist with the narrower per-concept overrides layered on top of it;
 * first-match-wins would make declaration order load-bearing and turn a reordering into a policy
 * change.
 */
export function resolvePolicy(policy, path) {
  let best = null;
  for (const entry of policy.entries) {
    if (!entry.matcher.test(path)) continue;
    if (entry.exceptionMatchers.some((re) => re.test(path))) continue;
    if (best === null || moreSpecific(entry.glob, best.glob)) best = entry;
  }
  return best;
}

/**
 * Is a change to `path` something the bundle may need to reflect?
 *
 * Two separate questions live here, and conflating them produced a real defect on the first live run:
 * "may this be written?" (the policy state) and "should the bundle SUMMARIZE it?". `CLAUDE.md` is
 * `regenerate` — an agent updates the index as the bundle changes — but it is an index INTO the
 * bundle, so a concept summarizing it would be circular. The planner duly proposed writing
 * `invariants/claude.md` and `invariants/agents.md`.
 *
 * `coverage: false` on an entry says "writable, but not a subject".
 */
export function isCoverageTarget(policy, path) {
  const entry = resolvePolicy(policy, path);
  if (entry === null || entry.coverage === false) return false;
  return COVERAGE_POLICIES.includes(entry.policy);
}

/**
 * May `actor` write `path`? Used at runtime by the maintenance run (FR-026e) against the paths that
 * actually appeared in the working tree — never against what the generator claimed it did.
 */
export function mayWrite(policy, path, actor = 'generator') {
  const entry = resolvePolicy(policy, path);
  if (entry === null) return { allowed: false, reason: 'no declared policy for this path', entry: null };
  if (entry.policy === 'excluded') return { allowed: false, reason: 'policy: excluded — never analyzed, never written', entry };
  if (entry.policy === 'never-written') return { allowed: false, reason: 'policy: never-written', entry };
  if (entry.policy === 'analyzable-not-covered') return { allowed: false, reason: 'policy: analyzable-not-covered — read for context, not a write target', entry };
  if (entry.actor !== actor) {
    return { allowed: false, reason: `policy governs actor \`${entry.actor ?? 'unset'}\`, not \`${actor}\``, entry };
  }
  return { allowed: true, reason: null, entry };
}
