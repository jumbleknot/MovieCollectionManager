// The concept provenance stamp: which front-matter date says "this page was last brought up to date
// against its source". ONE definition, imported by both readers — the OKF gate's V12 drift warning
// (check-openwiki-okf.mjs) and wiki-maintain's #587 stale-skip check — so the two cannot disagree.
//
// The stamp is the NEWEST of three fields (operator decision 2026-09-28):
//
//   generated.at  OKF v0.2. openwiki >=0.5.0 adds it, and strips `timestamp`, on a page whose body it
//                 rewrote in a run.
//   verified.at   openwiki's Grounded Claims: set only after a complete claims set reconciled and
//                 passed a final evidence recheck against the sources. It can be added WITHOUT
//                 touching `generated` or `timestamp` — measured on adr-0001-prod-secrets-management.md
//                 (verified 17:17Z, source changed 16:17Z, reported stale) and on agent-gateway.md
//                 (body rewritten by 0.6.0, only `verified` added). Written as a LIST of events.
//   timestamp     OKF v0.1, tolerated by v0.2 on pages not yet rewritten, and on hand-authored ones.
//
// Newest rather than first-present, because each field is an event and the latest event is the last
// time anything checked the page. An older verification can never drag a newer generation backwards.

const EVENT_FIELDS = ['generated', 'verified'];

const trimmed = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** A `{by, at}` event field may be one mapping or a list of them; yield each `at`. */
function eventAts(value) {
  const events = Array.isArray(value) ? value : [value];
  return events
    .filter((e) => e !== null && typeof e === 'object' && !Array.isArray(e))
    .map((e) => trimmed(e.at))
    .filter((at) => at !== null);
}

/**
 * Every stamp value present, in a fixed order (generated.at, verified.at…, timestamp), each with the
 * field it came from. V5 validates all of them; `conceptStamp` picks among them.
 */
export function stampValues(fields) {
  if (fields === null || typeof fields !== 'object') return [];
  const out = [];
  for (const key of EVENT_FIELDS) {
    for (const value of eventAts(fields[key])) out.push({ value, field: `${key}.at` });
  }
  const ts = trimmed(fields.timestamp);
  if (ts !== null) out.push({ value: ts, field: 'timestamp' });
  return out;
}

/**
 * The newest parseable stamp, as `{value, field}` so a message can name the shape it read. When
 * values are present but none parses, the first comes back unchanged: the caller's `Date.parse`
 * then yields NaN and counts the page unstampable, rather than this function hiding it as "no stamp".
 * No value at all is `null`.
 */
export function conceptStamp(fields) {
  const values = stampValues(fields);
  if (values.length === 0) return null;
  let newest = null;
  for (const v of values) {
    const ms = Date.parse(v.value);
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest.ms) newest = { ...v, ms };
  }
  if (newest === null) return values[0];
  return { value: newest.value, field: newest.field };
}
