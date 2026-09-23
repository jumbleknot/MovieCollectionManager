// Resolving, connection-pinning SSRF guard for backup destinations (feature 073, FR-005).
//
// This is a SECOND guard, not a replacement for `agent-config-ssrf.ts`, and the two differ in
// both policy and mechanism:
//
//   POLICY — still the whole difference. The Ollama guard ALLOWS private addresses, because the
//   user's own model server is the point of "bring your own Ollama". This guard DENIES them by
//   default. A destination endpoint is an address this server will send the user's entire
//   collection to, and mc-service, keycloak-service, the BFF's own Mongo and the container network
//   all sit in private space. A homelab NAS — the primary legitimate destination — gets in by being
//   named in BACKUP_ALLOWED_DESTINATION_HOSTS, a deliberate act by an operator.
//
//   MECHANISM — no longer a difference, as of item #542. The Ollama guard used to check the
//   hostname STRING and was DNS-blind by documented design; it now resolves and pins too, and the
//   shared pinning machinery moved to `pinned-agent.ts` so both can use it. Do not re-derive the
//   old claim from an older comment: `agent-config-ssrf.ts` resolves.
//
// THE PINNING IS THE POINT. Resolve-then-connect without pinning leaves a TOCTOU window: the name
// is checked, the resolver is asked again by the HTTP stack, and the second answer is the one
// connected to. A guard with that window is theatre. `createPinnedAgent` supplies a `lookup` that
// can only ever return a vetted address, so the address checked and the address connected to are
// the same by construction rather than by timing.

import { isIP } from 'node:net';
import { promises as dns } from 'node:dns';

import { env } from '@/config/env';

export interface VettedDestination {
  /** The hostname as written, lower-cased and de-bracketed. Used for SNI and certificate checks. */
  hostname: string;
  /** The first vetted address — what a caller reports or logs. */
  address: string;
  family: 4 | 6;
  /**
   * EVERY address that passed the check, in resolution order.
   *
   * The connection is pinned to this SET, not to a single member, and that is a correction to an
   * earlier design rather than a convenience. Pinning to one address removes the OS's normal
   * dual-stack fallback: MEASURED here, `localhost` resolves to `::1` first while the target
   * bound only 127.0.0.1, so every request died on `ECONNREFUSED ::1:9100` against a server that
   * was up and reachable. A destination with both an A and an AAAA record where only one answers
   * is the same situation in production.
   *
   * The security property is untouched, because it was never about connecting to exactly one
   * address — it is that every address connected to has been CHECKED. All of these have.
   */
  addresses: { address: string; family: 4 | 6 }[];
  port: number;
  protocol: 'http:' | 'https:';
  /** The parsed URL, so callers do not re-parse and risk disagreeing with what was vetted. */
  url: URL;
}

/** Carries a SAFE, user-facing reason. Never an upstream body, a resolver message, or a stack. */
export class DestinationUrlNotAllowedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = 'DestinationUrlNotAllowedError';
    this.reason = reason;
  }
}

/** The resolver seam — `dns.lookup(host, { all: true })` in production, a stub under test. */
export type DestinationLookup = (
  hostname: string,
) => Promise<{ address: string; family: number }[]>;

const NOT_ALLOWED =
  'That address is not allowed. Backups may not be sent to a loopback, private, link-local or ' +
  'cloud-metadata address unless the host is on the configured backup destination allow-list.';
const NOT_HTTP = 'A backup destination must be an http(s) URL';
const UNRESOLVABLE = 'That host could not be resolved to an address';

// ─── Address classification ────────────────────────────────────────────────────

/**
 * De-map an IPv4-mapped IPv6 address to the underlying IPv4, else null.
 *
 * Both spellings are handled because WHATWG `new URL()` canonicalizes the readable
 * `::ffff:169.254.169.254` into the hex `::ffff:a9fe:a9fe`. A dotted-decimal check alone never
 * fires on the canonical form, which is how a literal cloud-metadata address slips past a guard
 * that looks correct. This logic is lifted from `agent-config-ssrf.ts`, where it is correct and
 * load-bearing, rather than being written a second time and drifting.
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

function isBlockedIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) {
    return true; // unparseable is not a reason to allow it
  }
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 — "this network", and the unspecified address
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. the IMDS at 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // RFC 2544 benchmarking
  // 100.64/10 — carrier-grade NAT, and the range Tailscale hands out. Blocked by default with the
  // rest of non-public space: a tailnet destination is legitimate but is still a private network,
  // so it is admitted the same way a NAS is — by being named on the allow-list, deliberately.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true; // multicast (224/4) and reserved (240/4), incl. 255.255.255.255
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const host = address.toLowerCase();
  const v4 = mappedIpv4(host);
  if (v4) return isBlockedIpv4(v4);
  if (host === '::' || host === '::1') return true; // unspecified, loopback
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(host)) return true; // fc00::/7 unique-local, incl. fd00:ec2::254 (IMDS)
  if (/^ff/.test(host)) return true; // ff00::/8 multicast
  return false;
}

/** True when this address must not be connected to unless its host is explicitly allow-listed. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version === 6) return isBlockedIpv6(address);
  return true; // not an address at all
}

function allowedHosts(): string[] {
  return env.backupAllowedDestinationHosts
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

// ─── The guard ─────────────────────────────────────────────────────────────────

const defaultLookup: DestinationLookup = async (hostname) =>
  dns.lookup(hostname, { all: true, verbatim: true });

/**
 * Validate a destination URL and return the address every connection to it must be pinned to.
 *
 * Throws `DestinationUrlNotAllowedError` with a safe reason. Called on SAVE, on every PROBE and on
 * every USE — a name that was safe when saved can resolve somewhere else by the time a scheduled
 * run writes to it, so a save-time-only check would be a check of the past.
 */
export async function assertDestinationUrlAllowed(
  value: string,
  opts: { lookup?: DestinationLookup } = {},
): Promise<VettedDestination> {
  const lookup = opts.lookup ?? defaultLookup;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DestinationUrlNotAllowedError(NOT_HTTP);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DestinationUrlNotAllowedError(NOT_HTTP);
  }

  const hostname = normalizeHost(url.hostname);
  if (!hostname) throw new DestinationUrlNotAllowedError(NOT_HTTP);

  // EXACT match only. A substring or suffix test would admit `nas.home.arpa.attacker.test` to an
  // allow-list containing `nas.home.arpa`, which is the classic way an allow-list becomes a
  // vulnerability instead of a control.
  const allowListed = allowedHosts().includes(hostname);
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));

  const literal = isIP(hostname);
  if (literal) {
    // An IP literal is its own answer; resolving it would be a second, pointless question.
    if (!allowListed && isBlockedAddress(hostname)) {
      throw new DestinationUrlNotAllowedError(NOT_ALLOWED);
    }
    const family = literal === 6 ? (6 as const) : (4 as const);
    return {
      hostname,
      address: hostname,
      family,
      addresses: [{ address: hostname, family }],
      port,
      protocol: url.protocol,
      url,
    };
  }

  let answers: { address: string; family: number }[];
  try {
    answers = await lookup(hostname);
  } catch {
    // The resolver's own message can name internal DNS servers and search domains, so it is
    // swallowed rather than forwarded to a user-facing reason.
    throw new DestinationUrlNotAllowedError(UNRESOLVABLE);
  }
  if (!answers || answers.length === 0) {
    // A name with no answers is unresolvable, NOT safe. Treating an empty result as "nothing
    // blocked was found" is how a guard ends up defaulting to allow.
    throw new DestinationUrlNotAllowedError(UNRESOLVABLE);
  }

  if (!allowListed) {
    // EVERY answer, not the first. A record returning one public and one private address is the
    // shape that defeats a guard checking answers[0], and it is trivially arranged by whoever
    // controls the name.
    for (const answer of answers) {
      if (isBlockedAddress(answer.address)) {
        throw new DestinationUrlNotAllowedError(NOT_ALLOWED);
      }
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
    protocol: url.protocol,
    url,
  };
}

// ─── Pinning ───────────────────────────────────────────────────────────────────

// The mechanism moved to `pinned-agent.ts` in item #542, so the Ollama guard could pin as well
// without importing from a backups module. Re-exported here because this is still where callers
// in this feature expect to find it, and because the guard result and the pinning belong together
// at the call site. `VettedDestination` satisfies `PinnedTarget` structurally.
export { createPinnedAgent, type PinnedTarget } from '@/bff-server/pinned-agent';
