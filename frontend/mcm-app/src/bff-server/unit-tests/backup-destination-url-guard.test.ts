// Unit tests for the backup-destination URL guard (feature 073, FR-005 / SC-011 / US1-AC4).
//
// WHY A SECOND GUARD EXISTS. The backlog item said to reuse `validateOllamaUrl`. It cannot be
// reused, for two independent reasons:
//
//  1. Its POLICY is the opposite of what is needed here. "Bring your own Ollama" allows private
//     and loopback addresses by design, because the user's own model server is the primary case.
//     A backup destination is an address this server POSTs the user's entire collection to, and
//     mc-service, keycloak-service and the BFF's own Mongo all live in private space. So private
//     ranges are DENIED here by default, and a homelab NAS gets in by being named in
//     BACKUP_ALLOWED_DESTINATION_HOSTS.
//
//  2. It is DNS-BLIND by documented design — openwiki/gotchas/agent-config-ssrf-guard.md records
//     that as a residual risk in those words. It checks the hostname STRING. A name that resolves
//     to 169.254.169.254 passes it. Group 3 below is that case, and it is the capability this
//     module adds: resolve first, check every answer, then connect to the address that was
//     checked.
//
// The resolver is injected so group 3 asserts real behaviour rather than depending on a DNS
// record that would have to exist somewhere. If group 3 ever passes against an implementation
// that never calls the resolver, the TEST is wrong, not the guard.

import { env } from '@/config/env';
import {
  assertDestinationUrlAllowed,
  DestinationUrlNotAllowedError,
  type DestinationLookup,
} from '@/bff-server/backup-destination-url-guard';

jest.mock('@/config/env', () => ({ env: { backupAllowedDestinationHosts: '' } }));

const mockEnv = env as unknown as { backupAllowedDestinationHosts: string };

/** A resolver seam standing in for dns.promises.lookup(host, { all: true }). */
const resolverReturning = (...addresses: string[]): jest.MockedFunction<DestinationLookup> =>
  jest.fn(async (_hostname: string) =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
  );

/** An IP literal needs no resolution; this proves it if one is ever attempted anyway. */
const neverCalled: jest.MockedFunction<DestinationLookup> = jest.fn(async (_hostname: string) => {
  throw new Error('resolver must not be called for an IP literal');
});

async function rejectionReason(url: string, lookup: DestinationLookup = neverCalled): Promise<string> {
  try {
    await assertDestinationUrlAllowed(url, { lookup });
    throw new Error(`expected ${url} to be rejected, but it was allowed`);
  } catch (err) {
    if (!(err instanceof DestinationUrlNotAllowedError)) throw err;
    return err.reason;
  }
}

beforeEach(() => {
  mockEnv.backupAllowedDestinationHosts = '';
  neverCalled.mockClear();
});

describe('group 1 — literal blocked addresses', () => {
  // Every one of these is a literal IP, so no resolution is involved and the guard must reject
  // on the address in the URL itself.
  it.each([
    ['cloud metadata (IMDS)', 'http://169.254.169.254/latest/meta-data/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv6 cloud metadata', 'http://[fd00:ec2::254]/'],
    ['loopback', 'http://127.0.0.1:9000/'],
    ['private class A', 'http://10.0.0.5:9000/'],
    ['private class C', 'http://192.168.1.10:9000/'],
  ])('rejects %s', async (_label, url) => {
    expect(await rejectionReason(url)).toMatch(/not allowed/i);
  });

  it('rejects the unspecified address', async () => {
    expect(await rejectionReason('http://0.0.0.0:9000/')).toMatch(/not allowed/i);
  });

  it('rejects a non-http(s) scheme before looking at the address at all', async () => {
    expect(await rejectionReason('file:///etc/passwd')).toMatch(/http/i);
    expect(await rejectionReason('ftp://example.com/')).toMatch(/http/i);
    expect(await rejectionReason('not a url')).toMatch(/http/i);
  });

  it('allows a public address, and returns the vetted address so the caller can pin to it', async () => {
    const vetted = await assertDestinationUrlAllowed('https://s3.example.com/', {
      lookup: resolverReturning('93.184.216.34'),
    });
    expect(vetted.address).toBe('93.184.216.34');
    expect(vetted.hostname).toBe('s3.example.com');
    expect(vetted.family).toBe(4);
    expect(vetted.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  it('carries EVERY vetted address, so a dual-stack host keeps its fallback', () => {
    // Pinning to one address removes the OS's normal A/AAAA fallback. Measured against the
    // integration target: `localhost` resolves to ::1 first while the server bound 127.0.0.1
    // only, and every request died on ECONNREFUSED against a server that was up. Returning the
    // whole vetted set restores the fallback without weakening anything — the guarantee is that
    // every address connected to was checked, and all of these were.
    return assertDestinationUrlAllowed('https://dual.example.com/', {
      lookup: resolverReturning('2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34'),
    }).then((vetted) => {
      expect(vetted.addresses).toHaveLength(2);
      expect(vetted.addresses.map((a) => a.family)).toEqual([6, 4]);
    });
  });
});

describe('group 2 — canonicalization', () => {
  // WHATWG `new URL()` rewrites ::ffff:169.254.169.254 to the HEX form ::ffff:a9fe:a9fe, so a
  // dotted-decimal regex never fires on it. Both spellings must be de-mapped to the underlying
  // IPv4 and blocked on that.
  it('rejects the IPv4-mapped IPv6 spelling of the metadata address', async () => {
    expect(await rejectionReason('http://[::ffff:169.254.169.254]/')).toMatch(/not allowed/i);
  });

  it('rejects the canonical hex form the URL parser produces', async () => {
    expect(await rejectionReason('http://[::ffff:a9fe:a9fe]/')).toMatch(/not allowed/i);
  });

  it('rejects a mapped loopback — mapping is not a way to launder a blocked address', async () => {
    expect(await rejectionReason('http://[::ffff:127.0.0.1]:9000/')).toMatch(/not allowed/i);
  });
});

describe('group 3 — the resolving case, which the Ollama guard cannot catch', () => {
  it('rejects a public-looking hostname that RESOLVES to cloud metadata', async () => {
    const lookup = resolverReturning('169.254.169.254');
    expect(await rejectionReason('https://backup.example.com/', lookup)).toMatch(/not allowed/i);
    // The assertion that makes this test meaningful: a guard that never resolves would reach the
    // same verdict only by accident, and would let the NEXT such hostname through.
    expect(lookup).toHaveBeenCalled();
  });

  it('rejects a hostname that resolves into private space', async () => {
    const lookup = resolverReturning('10.1.2.3');
    expect(await rejectionReason('https://nas.example.com/', lookup)).toMatch(/not allowed/i);
    expect(lookup).toHaveBeenCalled();
  });

  it('rejects when ANY answer is blocked, not merely the first', async () => {
    // Checking only answers[0] is the subtle version of this bug: it passes every test where the
    // blocked address happens to sort first, and ships a guard that a round-robin record defeats.
    const lookup = resolverReturning('93.184.216.34', '169.254.169.254');
    expect(await rejectionReason('https://split.example.com/', lookup)).toMatch(/not allowed/i);
  });

  it('rejects a hostname that resolves to nothing rather than treating it as safe', async () => {
    const lookup: jest.MockedFunction<DestinationLookup> = jest.fn(async (_hostname: string) => []);
    expect(await rejectionReason('https://void.example.com/', lookup)).toMatch(/resolve/i);
  });

  it('rejects a hostname whose resolution fails, and does not leak the resolver error', async () => {
    const lookup: jest.MockedFunction<DestinationLookup> = jest.fn(async (_hostname: string) => {
      throw new Error('getaddrinfo EAI_AGAIN internal-dns.corp');
    });
    const reason = await rejectionReason('https://broken.example.com/', lookup);
    expect(reason).toMatch(/resolve/i);
    expect(reason).not.toMatch(/internal-dns\.corp/);
  });
});

describe('group 4 — the allow-list', () => {
  // A homelab NAS is the PRIMARY legitimate destination for this feature, and it lives at a
  // private address. Without this, the guard's default-deny policy would block the main use case.
  it('admits a private address when its host is allow-listed', async () => {
    mockEnv.backupAllowedDestinationHosts = 'localhost,127.0.0.1,nas.home.arpa';
    const vetted = await assertDestinationUrlAllowed('http://127.0.0.1:9100/', {
      lookup: neverCalled,
    });
    expect(vetted.address).toBe('127.0.0.1');
  });

  it('admits an allow-listed hostname that resolves into private space', async () => {
    mockEnv.backupAllowedDestinationHosts = 'nas.home.arpa';
    const vetted = await assertDestinationUrlAllowed('http://nas.home.arpa:8080/', {
      lookup: resolverReturning('192.168.1.50'),
    });
    expect(vetted.address).toBe('192.168.1.50');
  });

  it('does not admit a host that merely RESEMBLES an allow-listed one', async () => {
    mockEnv.backupAllowedDestinationHosts = 'nas.home.arpa';
    expect(
      await rejectionReason('http://evil-nas.home.arpa.attacker.test/', resolverReturning('10.0.0.9')),
    ).toMatch(/not allowed/i);
  });

  it('still rejects cloud metadata even when the allow-list is set to something else', async () => {
    mockEnv.backupAllowedDestinationHosts = 'nas.home.arpa';
    expect(await rejectionReason('http://169.254.169.254/')).toMatch(/not allowed/i);
  });
});
