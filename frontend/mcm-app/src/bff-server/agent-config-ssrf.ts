// SSRF guard for the user-supplied Ollama base URL (feature 018 review #3; DNS fix in item #542).
//
// POLICY. "Bring your own Ollama" intentionally allows a private / LAN address — the user's own
// model server is the whole point — so a blanket private-range block would break the primary use
// case. Link-local and cloud-metadata are blocked ALWAYS. `AGENT_OLLAMA_ALLOWED_HOSTS` optionally
// narrows the whole thing to a named host list for hardened multi-user deployments.
//
// LOOPBACK IS NARROWED, NOT ALLOWED OUTRIGHT (item #542). Loopback used to be permitted the same
// way private space is, on the reasoning that it is "the common local case". Inside a container it
// is not the user's machine at all — it is THIS server — so an unrestricted allowance let a
// user-supplied URL address whatever else happens to be listening locally. Loopback is now
// permitted only on the ports Ollama itself uses (`AGENT_OLLAMA_LOOPBACK_PORTS`, default 11434),
// which keeps the bare-metal "Ollama on localhost" case working and closes the rest.
//
// MECHANISM. This guard used to check the literal host STRING and was DNS-blind by documented
// design. That was the residual risk item #542 exists to close: a name that resolved into a
// blocked range at request time was never caught. It now RESOLVES the name and checks EVERY
// answer, and `assertOllamaUrlAllowed` hands back those answers so the caller can pin the
// connection to them — the same resolve-then-pin shape as `backup-destination-url-guard.ts`,
// with the opposite policy. The two guards stay separate because the threats differ: an Ollama
// endpoint is EXPECTED to be on the LAN, a backup destination is expected to be remote.
//
// The check runs at SAVE and again at USE. That is what catches rebinding: a save-time-only check
// is a check of the past, and the answer can be different by the time a request is made.

import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

import { env } from '@/config/env';

export interface UrlCheckResult {
  ok: boolean;
  reason?: string;
}

/** The resolver seam — `dns.lookup(host, { all: true })` in production, a stub under test. */
export type OllamaLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

/**
 * A vetted Ollama endpoint plus every address that passed the check.
 *
 * Structurally compatible with `VettedDestination` from `backup-destination-url-guard.ts` so the
 * `createPinnedAgent` transport machinery there can be reused verbatim. Only the POLICY differs
 * between the two guards; the pinning is generic and is not worth writing twice.
 */
export interface VettedOllamaTarget {
  hostname: string;
  address: string;
  family: 4 | 6;
  /** EVERY vetted address, in resolution order — pinning to the SET preserves dual-stack fallback. */
  addresses: { address: string; family: 4 | 6 }[];
  port: number;
  protocol: 'http:' | 'https:';
  url: URL;
}

/** Carries a SAFE, user-facing reason. Never a resolver message, an upstream body, or a stack. */
export class OllamaUrlNotAllowedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'OllamaUrlNotAllowedError';
    this.reason = reason;
  }
}

const NOT_HTTP = 'Must be a valid http(s) URL';
const NOT_ALLOWED = 'That address is not allowed (link-local / cloud-metadata range)';
const NOT_ALLOWED_LOOPBACK =
  'That address is not allowed: a loopback address is this server, not your machine. Only the ' +
  'configured Ollama port may be reached over loopback.';
const NOT_ON_ALLOW_LIST = 'That host is not in the configured Ollama allow-list';
const UNRESOLVABLE = 'That host could not be resolved to an address';

// ─── Address classification ────────────────────────────────────────────────────

/**
 * De-map an IPv4-mapped IPv6 address to the underlying IPv4, else null.
 *
 * Both spellings are handled because WHATWG `new URL()` canonicalizes the readable
 * `::ffff:169.254.169.254` into the hex `::ffff:a9fe:a9fe`. A dotted-decimal check alone never
 * fires on the canonical form, which is how a literal cloud-metadata address slips past a guard
 * that looks correct (security review #1).
 */
function mappedIpv4(host: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/** The AWS IMDS-over-IPv6 address. Inside fc00::/7, which is otherwise ordinary LAN space. */
const METADATA_V6 = 'fd00:ec2::254';

type Verdict = 'allow' | 'blocked' | 'loopback';

function classifyIpv4(address: string): Verdict {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return 'blocked'; // unparseable is not a reason to allow it
  }
  const [a, b] = octets;
  if (a === 127) return 'loopback';
  if (a === 0) return 'blocked'; // 0.0.0.0/8 "this network", and the unspecified address
  if (a === 169 && b === 254) return 'blocked'; // link-local, incl. the IMDS at 169.254.169.254
  if (a >= 224) return 'blocked'; // multicast (224/4) and reserved (240/4)
  // RFC 1918, CGNAT and public space are all ALLOWED here — that is the BYO-Ollama policy, and
  // it is the deliberate difference from the backup destination guard.
  return 'allow';
}

function classifyIpv6(address: string): Verdict {
  const host = address.toLowerCase();
  const v4 = mappedIpv4(host);
  if (v4) return classifyIpv4(v4);
  if (host === '::1') return 'loopback';
  if (host === '::') return 'blocked'; // unspecified
  if (/^fe[89ab]/.test(host)) return 'blocked'; // fe80::/10 link-local
  if (host === METADATA_V6) return 'blocked'; // IMDS over IPv6
  if (/^ff/.test(host)) return 'blocked'; // ff00::/8 multicast
  // fc00::/7 unique-local is an ordinary LAN for this policy — only the IMDS address above is out.
  return 'allow';
}

/** Classify a literal address under the OLLAMA policy (not the backup one). */
export function classifyOllamaAddress(address: string): Verdict {
  const version = isIP(address);
  if (version === 4) return classifyIpv4(address);
  if (version === 6) return classifyIpv6(address);
  return 'blocked'; // not an address at all
}

// ─── Configuration ─────────────────────────────────────────────────────────────

function allowedHosts(): string[] {
  return env.agentOllamaAllowedHosts
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function loopbackPorts(): number[] {
  return env.agentOllamaLoopbackPorts
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
}

function normalizeHost(hostname: string): string {
  // URL.hostname keeps IPv6 in brackets only in .host, not .hostname; strip defensively anyway.
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

// ─── The guard ─────────────────────────────────────────────────────────────────

const defaultLookup: OllamaLookup = async (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

/**
 * Validate a user-supplied Ollama base URL and return every address a connection may be pinned to.
 *
 * Throws `OllamaUrlNotAllowedError` with a safe, field-attributable reason. Call this on SAVE and
 * again on every USE — the answer for a name can change between the two, which is the rebinding
 * case this exists to catch.
 */
export async function assertOllamaUrlAllowed(
  value: string,
  opts: { lookup?: OllamaLookup } = {},
): Promise<VettedOllamaTarget> {
  const lookup = opts.lookup ?? defaultLookup;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OllamaUrlNotAllowedError(NOT_HTTP);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OllamaUrlNotAllowedError(NOT_HTTP);
  }

  const hostname = normalizeHost(url.hostname);
  if (!hostname) throw new OllamaUrlNotAllowedError(NOT_HTTP);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

  // EXACT match only. A substring or suffix test would admit `nas.home.arpa.attacker.test` to an
  // allow-list containing `nas.home.arpa`, which is how an allow-list becomes a vulnerability
  // rather than a control. Note this only ever RESTRICTS: being listed does not exempt a host
  // from the address checks below, so allow-listing the metadata address still does not reach it.
  const allow = allowedHosts();
  if (allow.length > 0 && !allow.includes(hostname)) {
    throw new OllamaUrlNotAllowedError(NOT_ON_ALLOW_LIST);
  }

  const literal = isIP(hostname);
  const answers = literal
    ? [{ address: hostname, family: literal }]
    : await resolveOrThrow(lookup, hostname);

  // EVERY answer, not the first. A record returning one public and one blocked address is the
  // shape that defeats a guard checking answers[0], and whoever controls the name can arrange it.
  for (const answer of answers) {
    const verdict = classifyOllamaAddress(answer.address);
    if (verdict === 'blocked') throw new OllamaUrlNotAllowedError(NOT_ALLOWED);
    if (verdict === 'loopback' && !loopbackPorts().includes(port)) {
      throw new OllamaUrlNotAllowedError(NOT_ALLOWED_LOOPBACK);
    }
  }

  const addresses = answers.map((a) => ({
    address: a.address,
    family: (a.family === 6 ? 6 : 4) as 4 | 6,
  }));
  return {
    hostname,
    address: addresses[0].address,
    family: addresses[0].family,
    addresses,
    port,
    protocol: url.protocol as 'http:' | 'https:',
    url,
  };
}

async function resolveOrThrow(
  lookup: OllamaLookup,
  hostname: string,
): Promise<{ address: string; family: number }[]> {
  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(hostname);
  } catch {
    // The resolver's own message can name internal DNS servers and search domains, so it is
    // swallowed rather than forwarded into a user-facing reason.
    throw new OllamaUrlNotAllowedError(UNRESOLVABLE);
  }
  if (!answers || answers.length === 0) {
    // A name with no answers is unresolvable, NOT safe. Treating an empty result as "nothing
    // blocked was found" is how a guard ends up defaulting to allow.
    throw new OllamaUrlNotAllowedError(UNRESOLVABLE);
  }
  return answers;
}

/**
 * The save-path wrapper: the same check, reported as a field error rather than thrown.
 */
export async function validateOllamaUrl(
  value: string,
  opts: { lookup?: OllamaLookup } = {},
): Promise<UrlCheckResult> {
  try {
    await assertOllamaUrlAllowed(value, opts);
    return { ok: true };
  } catch (err) {
    if (err instanceof OllamaUrlNotAllowedError) return { ok: false, reason: err.reason };
    throw err;
  }
}
