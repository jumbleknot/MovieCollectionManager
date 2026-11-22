// Feature 105 US2 — output of the interactive commands (contracts/cli.md "Rules shared by every
// interactive command"): a fixed-width table capped at 10 rows with a `… N more` line, or `--json` with
// every row. Every value is redacted on the way out (FR-021): tailnet names and credential shapes by
// the shared publication redactor, plus the configured store and token hosts by name, since those
// need not be *.ts.net names.
import { redactForPublication } from '../../ci-digest-redact.mjs';

export const MAX_ROWS = 10;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Redact one line of output. `hosts` are host names to replace with `<store>`. */
export function redactLine(text, { hosts = [] } = {}) {
  let out = redactForPublication(String(text));
  for (const h of hosts) if (h) out = out.replace(new RegExp(escapeRe(h), 'gi'), '<store>');
  return out;
}

/** The host names of the configured URLs, for redactLine. */
export function configuredHosts(env = process.env) {
  const hosts = [];
  for (const k of ['MCM_USAGE_INGEST_URL', 'MCM_USAGE_TOKEN_URL']) {
    try { if (env[k]) hosts.push(new URL(env[k]).hostname); } catch { /* not a URL */ }
  }
  return hosts;
}

const fmt = (v) => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : String(Math.round(v * 1000) / 1000);
  if (Array.isArray(v)) return v.join(',');
  return String(v);
};

function redactDeep(v, hosts) {
  if (typeof v === 'string') return redactLine(v, { hosts });
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, hosts));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, hosts)]));
  return v;
}

/**
 * @param {object[]} rows
 * @param {{key: string, label?: string, align?: 'left'|'right'}[]} columns
 * @param {{json?: boolean, limit?: number, hosts?: string[]}} opts
 */
export function renderTable(rows, columns, { json = false, limit = MAX_ROWS, hosts = [] } = {}) {
  if (json) return JSON.stringify(redactDeep(rows, hosts), null, 2);
  if (rows.length === 0) return '(no rows)';
  const shown = rows.slice(0, limit);
  const cells = shown.map((r) => columns.map((c) => redactLine(fmt(r[c.key]), { hosts })));
  const heads = columns.map((c) => c.label ?? c.key);
  const widths = columns.map((_, i) => Math.max(heads[i].length, ...cells.map((r) => r[i].length)));
  const line = (vals) => vals.map((v, i) => (columns[i].align === 'right' ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ');
  const out = [line(heads), ...cells.map(line)];
  if (rows.length > shown.length) out.push(`… ${rows.length - shown.length} more`);
  return out.join('\n');
}
