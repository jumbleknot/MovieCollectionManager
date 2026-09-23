// Connection pinning for server-side fetches of a user-supplied URL.
//
// Extracted from `backup-destination-url-guard.ts` (item #542) so the Ollama guard can pin too.
// This module is deliberately POLICY-FREE: which addresses are acceptable is the guard's business
// and the two guards answer it very differently (an Ollama endpoint is expected to be on the LAN,
// a backup destination is expected to be remote). What is identical between them, and is not worth
// writing twice, is the mechanism below.
//
// THE PINNING IS THE POINT. Resolve-then-connect without pinning leaves a TOCTOU window: the name
// is checked, the resolver is asked AGAIN by the HTTP stack, and the second answer is the one
// connected to. A guard with that window is theatre. The `lookup` supplied here can only ever
// return an address that was already vetted, so the address checked and the address connected to
// are the same by construction rather than by timing.

import * as http from 'node:http';
import * as https from 'node:https';

/**
 * The minimum a guard must hand over for its result to be pinnable.
 *
 * Structural, not nominal, so both `VettedDestination` (backups) and `VettedOllamaTarget`
 * (agent config) satisfy it without either importing the other.
 */
export interface PinnedTarget {
  /** The first vetted address. */
  address: string;
  family: 4 | 6;
  /**
   * EVERY address that passed the guard, in resolution order.
   *
   * Pinning to the SET rather than to one member is a correction to an earlier design, not a
   * convenience. Pinning to a single address removes the OS's normal dual-stack fallback:
   * MEASURED, `localhost` resolves to `::1` first while the target bound only 127.0.0.1, so every
   * request died on `ECONNREFUSED ::1:9100` against a server that was up. The security property is
   * untouched — it was never "connect to exactly one address", it is "every address connected to
   * has been CHECKED", and all of these have.
   */
  addresses: { address: string; family: 4 | 6 }[];
  protocol: 'http:' | 'https:';
}

// Node's `LookupFunction` shape, spelled out because the exported one is not part of the public
// type surface in a way that survives `tsc --noEmit` here.
type NodeLookup = (
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | { address: string; family: number }[],
    family?: number,
  ) => void,
) => void;

/**
 * An HTTP(S) agent whose resolver can only return a vetted address.
 *
 * The connection is still made with the original HOSTNAME — so TLS SNI and certificate
 * verification are unchanged and the target keeps a valid certificate — while the socket goes to
 * an address that was actually checked.
 */
export function createPinnedAgent(target: PinnedTarget): http.Agent | https.Agent {
  const pinnedLookup: NodeLookup = (_hostname, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
    const options = typeof optionsOrCallback === 'function' ? {} : (optionsOrCallback ?? {});
    // `all: true` callers expect an array; everyone else expects (address, family). `all: true` is
    // what Node's connect path uses for its dual-stack attempt sequence, so handing back EVERY
    // vetted address is what restores the fallback that single-address pinning removed.
    if ((options as { all?: boolean }).all) {
      callback(null, target.addresses.map((a) => ({ address: a.address, family: a.family })));
    } else {
      callback(null, target.address, target.family);
    }
  };

  const options = { keepAlive: false, lookup: pinnedLookup };
  return target.protocol === 'https:' ? new https.Agent(options) : new http.Agent(options);
}
