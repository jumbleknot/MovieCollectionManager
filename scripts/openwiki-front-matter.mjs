// The openwiki concept front-matter reader. ONE definition, imported by the OKF gate
// (check-openwiki-okf.mjs) and by the source-fingerprint module (openwiki-fingerprint.mjs) that V17
// and wiki-refresh.mjs share — so the gate and the refresh tool can never read a page differently.

import { parse as parseYaml } from 'yaml';

/**
 * Normalize every string the front matter yields, ONCE, at the point the fields are read.
 *
 * On a CRLF checkout the last value before the closing `---` keeps a trailing '\r', because the
 * slice below ends at the '\n' of the terminator and leaves the '\r' inside the scalar. Validators
 * downstream then see '2001-01-01T00:00:00Z\r'. V5 survived that because it happened to call
 * `.trim()` first; the old V12 guard did not, so `Date.parse` returned NaN, the guard read that as
 * "no usable timestamp", and the staleness check silently never ran while the gate printed
 * `✅ conformant`. A gate reporting green while not checking is the worst direction of failure.
 *
 * Normalizing at the boundary — not with one more `.trim()` at the call site — is the point: the
 * asymmetry between two validators was the defect, so the fix has to remove the possibility of a
 * third validator being written without one.
 */
function normalizeFields(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(normalizeFields);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeFields(v)]));
  }
  return value;
}

/**
 * Parse a page's YAML front matter. Returns exactly one of:
 * `{missing: true}`, `{unterminated: true}`, `{invalid: <message>}` or `{fields}`.
 */
export function extractFrontMatter(text) {
  if (!/^---\r?\n/.test(text)) return { missing: true };
  const end = text.indexOf('\n---', 4);
  if (end === -1) return { unterminated: true };
  // The slice ends at the '\n' of the terminator, so on a CRLF page the last line keeps its '\r'.
  // A trailing scalar survives that (normalizeFields trims it), but a flow collection does not:
  // `tags: [a]\r` is a YAML parse error, which would fail V1 on any Windows checkout.
  const raw = text.slice(text.indexOf('\n') + 1, end).replace(/\r$/, '');
  try {
    const parsed = parseYaml(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { invalid: 'front matter is not a mapping' };
    }
    return { fields: normalizeFields(parsed) };
  } catch (err) {
    return { invalid: err.message.split('\n')[0] };
  }
}
