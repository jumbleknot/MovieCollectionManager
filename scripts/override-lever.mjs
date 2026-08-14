// Which lever clears this finding — refresh the lockfile, or raise the floor? (Feature 058, item #184)
//
// WHY THIS EXISTS. On 2026-08-13 the same fault was measured twice in one afternoon:
//
//     override    fast-uri@<3.1.4: '>=3.1.4 <4'    the range ALREADY PERMITTED 3.1.5
//     lockfile    fast-uri@3.1.4                   pinned the vulnerable one
//     npm         fast-uri@3.1.5 published 2026-07-31
//     advisory    GHSA-7p8r-x3mc-p8w7  published 2026-08-03   (three days AFTER the fix)
//
// The gate said "fast-uri@3.1.4 is vulnerable, fix >=3.1.5" — correct, and not enough. It left the
// reader to work out whether the override floor needed raising or the lockfile needed refreshing.
// Those are different actions, only one was needed, and the wrong reading is expensive: the gate
// stayed red for TEN DAYS and a four-week allowlist acceptance was written for something one command
// would have cleared. `nanoid` repeated it eight days later and reddened main.
//
// Renovate could not help, and structurally cannot: it proposes only when the current RANGE fails to
// satisfy the newest version, and `>=3.1.4 <4` satisfies every 3.x. It reasons about the manifest
// range, never the lockfile resolution. So an override that permits the fix looks already-fixed to
// it while the lockfile stays vulnerable, and nothing is proposed at all.
//
// SCOPE — THIS IS A MESSAGE, NOT A GATE. Nothing here may influence an exit code. `blocking`,
// `severity` and `scope` are read for display only and never filter advice: the two live cases on
// main (hono, undici 6.x) are non-blocking purely by severity, which is exactly the state fast-uri
// occupied before its advisory landed. Advice that waited for `blocking` would first appear once the
// finding was already reddening every branch. Making "an override already permits the fix" a second
// blocking axis alongside severity and scope is a POLICY change and is deliberately not done here.
//
// Pure functions only: no file I/O, no clock, no network, no process.exit. The caller supplies both
// the findings and the override map, so every case is testable without repository state.

import {
  parseOverrideKey, inclusiveLowerBound, exclusiveUpperBound, compareVersions,
} from './check-override-consistency.mjs';

/**
 * `hono@4.12.29` → `{ name: 'hono', version: '4.12.29' }`.
 *
 * Splits on the LAST `@`, exactly as `parseOverrideKey` does, so `@scope/name@1.2.3` yields the
 * scoped name while a bare `@expo/dom-webview` (whose only `@` is the scope marker at index 0) is
 * correctly not a location.
 */
export function parseLocation(location) {
  if (typeof location !== 'string') return null;
  const at = location.lastIndexOf('@');
  if (at <= 0) return null;
  const version = location.slice(at + 1);
  if (!/^\d/.test(version)) return null;
  return { name: location.slice(0, at), version };
}

/** The minimum fixed version from a `fixAvailable` range (`>=9.0.6` → `9.0.6`). `null` if unreadable. */
export function parseFixFloor(fixAvailable) {
  if (typeof fixAvailable !== 'string') return null;
  return inclusiveLowerBound(fixAvailable);
}

/** The override entry governing `name`, or `null`. Keyed floors and plain pins both match by name. */
function findOverride(name, overrides) {
  for (const [key, value] of Object.entries(overrides ?? {})) {
    const parsed = parseOverrideKey(key);
    const overrideName = parsed ? parsed.name : key;
    if (overrideName === name) return { key, value, keyed: Boolean(parsed) };
  }
  return null;
}

/**
 * Decide which lever clears one finding.
 *
 * @returns {null | {package: string, resolved: string, permitted: string, fixFloor: string,
 *                   action: 'refresh-lockfile' | 'raise-floor', message: string}}
 *
 * Returns `null` — silently, and deliberately unlike check-override-consistency.mjs, which refuses
 * unreadable input out loud with exit 2 — whenever there is nothing trustworthy to say. A GATE that
 * cannot read its input protects nothing and must shout; an AID that cannot read its input must not
 * obstruct the gate it prints alongside.
 */
export function adviseLever(finding, overrides) {
  if (!finding || finding.kind !== 'sca') return null;

  const loc = parseLocation(finding.location);
  if (!loc) return null;

  const fixFloor = parseFixFloor(finding.fixAvailable);
  if (!fixFloor) return null;

  const override = findOverride(loc.name, overrides);
  if (!override) return null;

  // A plain pin (`react-dom: 19.2.3`) has no range semantics to reason about. Out of scope, not a
  // violation — the same boundary check-override-consistency.mjs draws.
  if (!override.keyed) return null;

  const lower = inclusiveLowerBound(override.value);
  const upper = exclusiveUpperBound(override.value); // null → unbounded above, e.g. `>=4.12.25`
  if (lower === null) return null; // unreadable value; say nothing rather than guess

  // Already remediated: the finding is stale rather than actionable.
  if (compareVersions(loc.version, fixFloor) >= 0) return null;

  // Per RESOLUTION, not per package. `undici` resolves at both 6.27.0 and 7.24.7 while its override
  // governs only `>=6.27.0 <7`; recommending a refresh for the 7.x row would be advice the override
  // cannot deliver. Keying on the package name alone produces exactly that wrong answer.
  const inRange = compareVersions(loc.version, lower) >= 0
    && (upper === null || compareVersions(loc.version, upper) < 0);
  if (!inRange) return null;

  const permitsFix = compareVersions(fixFloor, lower) >= 0
    && (upper === null || compareVersions(fixFloor, upper) < 0);

  const base = {
    package: loc.name, resolved: loc.version, permitted: override.value, fixFloor,
  };

  if (permitsFix) {
    return {
      ...base,
      action: 'refresh-lockfile',
      message:
        `${loc.name} ${loc.version} — the override \`${override.value}\` ALREADY PERMITS ${fixFloor}; `
        + `the lockfile is what pins ${loc.version}. The override needs no edit — refresh the `
        + `lockfile: \`pnpm update ${loc.name} --lockfile-only\`.`,
    };
  }

  // The range cannot reach the fix, so both halves of the keyed override must move together.
  const suggestedKey = `${loc.name}@<${fixFloor}`;
  const suggestedValue = upper === null ? `>=${fixFloor}` : `>=${fixFloor} <${upper}`;
  return {
    ...base,
    action: 'raise-floor',
    message:
      `${loc.name} ${loc.version} — the override \`${override.value}\` does NOT permit ${fixFloor}, `
      + `so a lockfile refresh cannot clear this. Raise the floor, and BOTH HALVES move together: `
      + `\`${suggestedKey}: '${suggestedValue}'\` (currently \`${override.key}: '${override.value}'\`). `
      + 'Moving only the value leaves an override that reads as remediated while no longer excluding '
      + 'the version its own key names — check-override-consistency.mjs will fail it by name.',
  };
}

/**
 * Advice for a whole finding set, deduped on package + resolution + action.
 *
 * `hono@4.12.29` carries four advisories and must produce ONE line, not four. Dedupe is on the
 * resolution rather than the package so a second resolution of the same package still reports.
 */
export function selectAdvice(findings, overrides) {
  const seen = new Set();
  const out = [];
  for (const finding of findings ?? []) {
    const advice = adviseLever(finding, overrides);
    if (!advice) continue;
    const key = `${advice.package}@${advice.resolved}:${advice.action}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(advice);
  }
  return out;
}

/** Printable block. Never writes to stdout itself — the gate owns its output. */
export function formatAdvice(entries) {
  const refresh = entries.filter((e) => e.action === 'refresh-lockfile');
  const raise = entries.filter((e) => e.action === 'raise-floor');
  const lines = [];
  if (refresh.length > 0) {
    lines.push('  Already permitted by an existing override — REFRESH THE LOCKFILE:');
    for (const e of refresh) lines.push(`    • ${e.message}`);
  }
  if (raise.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('  Not reachable by the current override — RAISE THE FLOOR (both halves):');
    for (const e of raise) lines.push(`    • ${e.message}`);
  }
  return lines.join('\n');
}
