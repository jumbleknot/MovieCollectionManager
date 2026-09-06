// Allowlist expiry semantics — the single home, imported by both allowlist gates.
//
// Contract: specs/057-dependency-security-loop/contracts/allowlist-expiry.module.md
//
// WHY THIS EXISTS. Expiry was BINARY in both gates (`check-sast-findings.mjs:80`,
// `check-infra-image-findings.mjs:89` — the same line, written twice): full suppression until the
// date, hard fail the next morning, and nothing in between. So a time-boxed acceptance announced
// itself at the moment of maximum disruption — usually on somebody else's unrelated pull request —
// and the remediation that needed its own branch and a real build got no notice at all.
//
// Three behaviours are added here, and the window's length is defined ONCE (FR-024): both gates
// import `WARNING_WINDOW_DAYS` and neither redeclares it.
//
// PURE, deliberately. `today` is always passed in and never read from the clock. That is what makes
// both inclusive boundaries testable without mocking time, and it is why classification is computed
// on UTC date boundaries — a runner's local timezone must not be able to shift an entry between
// `expiring` and `expired`.
//
// SHAPE-AGNOSTIC. The two allowlists' native entry shapes differ (`{scanner, id, locationPattern}`
// vs `{image, id}`), so each gate keeps its own compilation and passes in a NORMALIZED view:
//
//     { key, id, addedBy, expiry, scanner }
//
// `key` is a caller-supplied unique identity, NOT the advisory id: both files reuse ids across
// targets (CVE-2025-68121 appears against hashicorp/vault and minio/mc; GHSA-7rqj-j65f-68wh against
// both langfuse images). Keying unmatched-detection on the id alone would let one entry's match
// silently cover another entry's staleness.
//
// NOTE ON ONE SIGNATURE. The contract lists `formatExpiring(entries)`. It takes `(entries, today)`
// here because it must print DAYS REMAINING (FR-020) and this module is forbidden from reading the
// clock — the alternative, making every caller precompute the count, duplicates the arithmetic at
// two call sites and invites them to diverge. The required CONTENT is unchanged.

/**
 * How many days before an expiry an entry starts being reported while still suppressing.
 *
 * THE ONLY DEFINITION IN THE REPOSITORY (FR-024). Chosen over 21 and 28 deliberately: keeping
 * entries OUT of the window most of the time is what keeps a red check meaningful, and that is worth
 * more here than maximum lead time. The accepted cost is that a remediation needing its own branch
 * and build gets two weeks' notice rather than three.
 */
export const WARNING_WINDOW_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** Parse an ISO `YYYY-MM-DD` to a UTC-midnight epoch. Returns NaN for anything else. */
function utcMidnight(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * Whole days from `today` to `expiry`; negative once past. Both arguments ISO `YYYY-MM-DD`.
 *
 * Computed on UTC date boundaries rather than by local-time arithmetic, so neither a runner's
 * timezone nor a daylight-saving transition can move a classification by a day.
 */
export function daysUntil(expiry, today) {
  return Math.round((utcMidnight(expiry) - utcMidnight(today)) / MS_PER_DAY);
}

/**
 * `'active' | 'expiring' | 'expired'` — derived, never stored.
 *
 * BOTH BOUNDARIES ARE INCLUSIVE, which is what removes the ambiguity in "14 days":
 *   - `daysUntil === WARNING_WINDOW_DAYS` → `expiring` (the far edge is inside the window)
 *   - `expiry === today`                  → `expiring` (an entry suppresses through the whole of
 *                                            its final day), NOT `expired`
 *
 * Only `'expired'` stops suppression, preserving both gates' existing behaviour exactly.
 */
export function classifyExpiry(expiry, today) {
  if (expiry === undefined || expiry === null || expiry === '') return 'active';
  const days = daysUntil(expiry, today);
  if (Number.isNaN(days)) return 'active';
  if (days < 0) return 'expired';
  return days <= WARNING_WINDOW_DAYS ? 'expiring' : 'active';
}

/**
 * Entries that suppressed nothing this run AND whose scanner produced at least one finding.
 *
 * The second condition is the whole point (clarification Q2). Without it, a scanner that was
 * skipped, failed, or came back genuinely clean would flag every one of its entries, and the weekly
 * check would go red claiming stale allowlist hygiene when the real fault is a scan that never ran —
 * misattributing a failure that belongs to the scanning job.
 *
 * @param {Array<{key: string, scanner: string}>} entries normalized entries
 * @param {Set<string>} matchedKeys identities of entries that suppressed >= 1 finding
 * @param {Set<string>} scannersWithFindings scanners that produced >= 1 finding in this run
 */
export function selectUnmatched(entries, matchedKeys, scannersWithFindings) {
  return entries.filter((e) => !matchedKeys.has(e.key) && scannersWithFindings.has(e.scanner));
}

const label = (e) => e.id;

/** `EXPIRING SOON` body — id, expiry date, days remaining, addedBy (FR-020). */
export function formatExpiring(entries, today) {
  return entries
    .map((e) => {
      const days = daysUntil(e.expiry, today);
      const plural = days === 1 ? 'day' : 'days';
      return `  ${label(e)}   expires ${e.expiry}   ${days} ${plural}   addedBy: ${e.addedBy}`;
    })
    .join('\n');
}

/**
 * The single `EXPIRED` line (FR-022) — the more valuable half of the change.
 *
 * It converts a confusing NEW blocking finding into a legible one: this used to be covered, until
 * this date, by an entry this person added. Without it the failure requires opening the allowlist
 * file to understand, on a branch that did not cause it.
 */
export function formatExpired(entry) {
  return `  ${label(entry)}  this finding was suppressed until ${entry.expiry} by an entry added by ${entry.addedBy}`;
}

/**
 * `UNMATCHED ENTRIES` body — id, addedBy, and that it suppressed nothing this run (FR-023).
 *
 * THE WORDING NAMES THREE CAUSES, NOT TWO (item #224). It used to offer exactly two — remediated,
 * or the scanner changed identifier namespace — and a rule that had gone BLIND read as the first of
 * them. Measured on this repository: the community rule `gha-curl-pipe-shell` re-parses a step's
 * `run:` block as Bash, could not read the ci-log-step heredoc that wraps nearly every run-step
 * here, and so produced 36 errors and 0 findings while the six `curl … | sh` lines it was written to
 * find sat in the workflows unexamined. Its entry was reported as suppressing nothing, and the two
 * explanations on offer both said "the code is fine now". Two causes stated as exhaustive is how
 * every future unmatched entry gets misread the same way.
 *
 * `annotate` is optional and this module stays SHAPE-AGNOSTIC: it knows nothing about any scanner.
 * A gate that holds the scan report (the SAST one does; the infra-image one has no equivalent) can
 * pass a function returning a per-entry detail line — which rule could not run, and how badly — and
 * gets it appended to that entry alone. Returning null, or passing nothing, leaves the line as it was.
 *
 * @param {Array<{id: string, addedBy: string}>} entries normalized entries
 * @param {(entry: object) => (string|null|undefined)} [annotate] optional per-entry detail
 */
export function formatUnmatched(entries, annotate) {
  return entries
    .map((e) => {
      const base = `  ${label(e)}  addedBy: ${e.addedBy} — matched nothing this run (remediated already, the scanner changed identifier namespace, or the rule could not run and so found nothing)`;
      const extra = annotate ? annotate(e) : null;
      return extra ? `${base}\n      ${extra}` : base;
    })
    .join('\n');
}
