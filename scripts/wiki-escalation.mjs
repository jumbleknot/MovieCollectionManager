// wiki-escalation.mjs — feature 078 US6: a page the job deadline stopped is retried at LOW reasoning
// effort on the next run, without the operator (spec FR-017..FR-023, plan D9).
//
// Pure. It decides two things and nothing else: which pages carry an escalation tag, and which effort
// an invocation should OVERRIDE. The tag map lives in the run record beside the backlog, never inside
// it, keyed by `area/page` because the planner rebuilds slices from scratch every run.
//
// Only a deadline stop escalates (exit 124/137 from `timeout` with a deadline in force), and the test
// is the exit status, never openwiki's text. A worker that "exited without submitting" is a different
// failure that `low` does not cure (item #682), so it must not be escalated.

import { resolveWikiProvider, WIKI_PROVIDERS } from './wiki-provider.mjs';

export const ESCALATED_EFFORT = 'low';

export const pageKey = (area, page) => `${area}/${page}`;

/** Keys of slice PARTS. An invocation's display `pages` are already `area/page`, so never key from them. */
const keysOf = (parts = []) => parts.flatMap((p) => (p.pages ?? []).map((page) => pageKey(p.area, page)));

export function isDeadlineStop(invocation, timeoutMs) {
  return timeoutMs !== null && timeoutMs !== undefined && (invocation?.status === 124 || invocation?.status === 137);
}

/** A copy holding only `pages`. Its stored run message named every original page, so it is dropped. */
function narrow(slice, pages) {
  const { runMessage: _stale, ...copy } = slice;
  const subjects = Object.fromEntries(Object.entries(slice.subjects ?? {}).filter(([p]) => pages.includes(p)));
  return { ...copy, pages, subjects };
}

export function splitByEscalation(slices, escalations = {}) {
  const escalated = [];
  const normal = [];
  for (const slice of slices) {
    const tagged = slice.pages.filter((p) => Object.hasOwn(escalations, pageKey(slice.area, p)));
    if (tagged.length === 0) normal.push(slice);
    else if (tagged.length === slice.pages.length) escalated.push(slice);
    else {
      escalated.push(narrow(slice, tagged));
      normal.push(narrow(slice, slice.pages.filter((p) => !tagged.includes(p))));
    }
  }
  return { escalated, normal };
}

export function escalationPolicy(env = process.env) {
  try {
    const { provider, reasoningEffort } = resolveWikiProvider(env);
    return { explicit: reasoningEffort ?? null, supportsLow: WIKI_PROVIDERS[provider].reasoningEfforts.includes(ESCALATED_EFFORT) };
  } catch {
    return { explicit: null, supportsLow: false }; // the preflight has already failed this run, loudly
  }
}

/** The effort to override for one invocation; null leaves the environment as it is. */
export function invocationEffort({ explicit, supportsLow }, escalated) {
  if (explicit) return null;
  return escalated && supportsLow ? ESCALATED_EFFORT : null;
}

export function nextEscalations({ prior = {}, outcomes = [], backlog = [], pageExists = () => false, now }) {
  const next = Object.fromEntries(Object.entries(prior ?? {}).map(([k, v]) => [k, { ...v }]));
  for (const o of outcomes) {
    for (const key of keysOf(o.ok ? o.parts : o.landedParts)) delete next[key];
    if (o.ok) continue;
    // Page-level when the verifier names the pages: a failed PART can hold pages that landed, and
    // those are cleared, never tagged or counted (review I1). Without it, every page of a failed part.
    const failed = new Set(o.failedPages ?? keysOf(o.failedParts));
    for (const key of keysOf(o.failedParts)) if (!failed.has(key)) delete next[key];
    for (const key of failed) {
      if (next[key]) {
        if (o.effortUsed === ESCALATED_EFFORT) next[key].failuresAtLow += 1;
      } else if (o.deadlineStop) {
        next[key] = { effort: ESCALATED_EFFORT, reason: 'deadline', since: now, failuresAtLow: o.effortUsed === ESCALATED_EFFORT ? 1 : 0 };
      }
    }
  }
  const queued = new Set(keysOf(backlog));
  for (const key of Object.keys(next)) if (!queued.has(key) && !pageExists(key)) delete next[key];
  return next;
}

export function stillFailing(prior = {}, next = {}) {
  return Object.entries(next)
    .filter(([key, t]) => prior?.[key] && t.failuresAtLow > prior[key].failuresAtLow)
    .map(([key, t]) => ({ key, failuresAtLow: t.failuresAtLow }));
}
