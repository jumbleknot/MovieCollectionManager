#!/usr/bin/env node
// Fail-closed redactor for CI failure digests (feature 042).
//
// FR-005 (credential redaction) + FR-017 (forge-host redaction). A digest is published to a PR
// comment — a far MORE visible surface than a run log — so this module is the feature's primary
// leak control.
//
// Two properties are load-bearing and easy to get wrong:
//
//   1. GLOBAL patterns. scripts/secret-scan.mjs is a DETECTOR: its regexes carry no /g, so a naive
//      .replace() against them rewrites only the FIRST occurrence and silently publishes every one
//      after it. Every pattern here is explicitly global.
//
//   2. FAIL-CLOSED verification. Detection and redaction disagree at the edges (secret-scan knows
//      credential shapes this module has no rewrite rule for). After redacting, the detection rules
//      are re-run over the OUTPUT; any surviving match drops the whole excerpt. Losing a log excerpt
//      is acceptable. Leaking a credential into a PR comment is not.
//
// The forge host is matched by SHAPE (*.ts.net), never by embedding the literal — the same approach
// scripts/check-topology-scrub.mjs documents, so this module cannot leak the host it protects.
//
// Usage:
//   node scripts/ci-digest-redact.mjs --selftest   # thin smoke check; exit 0/1
//
// Authoritative tests: scripts/__tests__/ci-digest-redact.test.mjs (CI-enforced via the
// guardrails/naming `node --test scripts/__tests__/*.test.mjs` step, feature 041).

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { RULES, scanText } from './secret-scan.mjs';

export const WITHHELD_NOTICE =
  '> ⚠️ Excerpt withheld — content matched a credential pattern after redaction.';

// Tailnet hosts that are documentation placeholders are already safe; rewriting them only destroys
// information. Same allowance check as check-topology-scrub.mjs.
// Case-insensitive: DNS is, and CI output uppercases hostnames constantly (env dumps, JVM stack
// traces, Windows tooling). A case-sensitive pattern published `BOX.<id>.TS.NET` verbatim.
const TS_NET = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net(?::\d+)?/gi;
const PLACEHOLDER_TOKENS = ['tailnet', 'example'];

// Tailscale CGNAT range, 100.64.0.0/10 — the tailnet host's ADDRESS is as topology-sensitive as its
// name, and CI logs carry resolved IPs constantly (docker inspect, ECONNREFUSED, getaddrinfo).
const TAILNET_IP = /\b100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g;

/**
 * A host is a documentation placeholder only if a whole LABEL is one of the placeholder words.
 * A substring test let `myexamplebox.<random>.ts.net` pass as "safe" and be published verbatim.
 */
function isPlaceholderHost(host) {
  return host
    .toLowerCase()
    .replace(/:\d+$/, '')
    .split('.')
    .some((label) => PLACEHOLDER_TOKENS.some((tok) => label === tok || label.split('-').includes(tok)));
}

/** Credential rewrite rules. Every pattern MUST be global — see note 1 in the header. */
const REWRITES = [
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '<redacted-jwt>'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, '$1<redacted>'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, '<redacted-anthropic-key>'],
  [/(mcm_(?:access_token|refresh_token|session_id)=)[^;"'\s\\]+/g, '$1<redacted>'],
  // Generic `key: value` credential assignment, the common shape of an env-derived leak in CI
  // output. Deliberately broad: on a publication surface, over-redacting is the safe direction.
  // `(?!<)` keeps this from eating an already-redacted placeholder: the JWT rule above rewrites
  // `token=eyJ…` to `token=<redacted-jwt>`, which this rule would otherwise re-redact — losing the
  // more specific label and breaking idempotency.
  [/((?:token|password|secret|api[_-]?key)["'\s]*[:=]\s*["']?)(?!<)(\S{12,})/gi, '$1<redacted>'],
  // The forge's OWN auth scheme — `Authorization: token <pat>` — which is what BOTH scripts in this
  // feature send. A captured `curl -v`, an undici debug dump or a `set -x` trace carries it
  // verbatim, and a raw forge PAT matches none of secret-scan's four narrow rules, so the
  // fail-closed verification pass would not catch it either.
  [/((?:^|\s)(?:Authorization:\s*)?token\s+)([A-Za-z0-9_-]{16,})/gi, '$1<redacted>'],
];

/** Rewrite credential shapes and the forge host. Idempotent: no rule matches its own output. */
export function redactForPublication(text) {
  let out = String(text);
  for (const [re, replacement] of REWRITES) out = out.replace(re, replacement);
  out = out.replace(TS_NET, (host) => (isPlaceholderHost(host) ? host : '<forge>'));
  return out.replace(TAILNET_IP, '<forge-ip>');
}

/**
 * Redact an excerpt, then VERIFY the result against the detection rules. A surviving match means
 * redaction and detection disagreed, so the excerpt is dropped rather than published.
 *
 * @returns {{text: string, withheld: boolean, rule: string|null}}
 */
export function redactExcerpt(text) {
  const redacted = redactForPublication(text);
  // relPath is only used by secret-scan's cassette-specific branch; a neutral path keeps the
  // general rules in play without opting into cassette checks.
  const residual = scanText('ci-digest-excerpt', redacted);
  if (residual.length > 0) {
    return { text: WITHHELD_NOTICE, withheld: true, rule: residual[0].rule };
  }
  return { text: redacted, withheld: false, rule: null };
}

/** Thin smoke check. The authoritative suite is scripts/__tests__/ci-digest-redact.test.mjs. */
function selftest() {
  const failures = [];
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
  if (redactForPublication(`${jwt} ${jwt}`).includes(jwt)) failures.push('JWT survived redaction');
  // Fragmented so no contiguous `.ts.net` literal sits in this file — see the note in
  // scripts/__tests__/ci-digest-redact.test.mjs. Do not collapse into one string.
  const probeHost = 'http://box.tailz9x8w7' + '.ts' + '.net:3000/x';
  if (!redactForPublication(probeHost).includes('<forge>')) {
    failures.push('tailnet host not rewritten to <forge>');
  }
  if (!redactExcerpt('Mcm-dev-' + 'planted' + '!').withheld) {
    failures.push('fail-closed verification did not withhold a residual credential match');
  }
  if (redactExcerpt('plain log line').withheld) failures.push('clean excerpt was needlessly withheld');
  if (RULES.length === 0) failures.push('detection rules failed to import from secret-scan.mjs');

  if (failures.length > 0) {
    console.error('✗ [ci-digest-redact --selftest] FAILED:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('✓ [ci-digest-redact --selftest] redaction is global, host-safe and fail-closed.');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--selftest')) selftest();
  else {
    console.error('Usage: node scripts/ci-digest-redact.mjs --selftest');
    process.exit(2);
  }
}
