// Unit tests for the Ollama base-URL SSRF guard.
//
// Feature 018 (review #3) established the POLICY: "bring your own Ollama" allows private/LAN by
// design, link-local + cloud-metadata are always blocked, and AGENT_OLLAMA_ALLOWED_HOSTS hardens a
// multi-user deploy. Item #542 fixed the MECHANISM: the guard used to check the literal host
// STRING, so a name that resolved into a blocked range was never caught. It now resolves the name
// and checks every answer, and the caller pins the connection to those answers.
//
// The `lookup` seam is injected here so the rebinding cases are deterministic rather than
// dependent on a resolver.

jest.mock('@/config/env', () => ({
  env: { agentOllamaAllowedHosts: '', agentOllamaLoopbackPorts: '11434' },
}));

import { env } from '@/config/env';
import {
  validateOllamaUrl,
  assertOllamaUrlAllowed,
  OllamaUrlNotAllowedError,
  type OllamaLookup,
} from './agent-config-ssrf';

const mockEnv = env as unknown as {
  agentOllamaAllowedHosts: string;
  agentOllamaLoopbackPorts: string;
};

/** A stub resolver: every name answers with the given addresses. */
const resolvesTo =
  (...addresses: string[]): OllamaLookup =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

/** Shorthand: run the guard, optionally with an injected resolver. */
const ok = (v: string, lookup?: OllamaLookup) => validateOllamaUrl(v, lookup ? { lookup } : {});

describe('validateOllamaUrl', () => {
  beforeEach(() => {
    mockEnv.agentOllamaAllowedHosts = '';
    mockEnv.agentOllamaLoopbackPorts = '11434';
  });

  describe('literal addresses (no resolution needed)', () => {
    it('allows a private-LAN Ollama URL by default', async () => {
      expect((await ok('http://10.0.0.5:11434')).ok).toBe(true);
      expect((await ok('http://192.168.1.20:11434')).ok).toBe(true);
      expect((await ok('http://172.16.4.4:11434')).ok).toBe(true);
    });

    it('blocks the cloud-metadata IP (always)', async () => {
      const r = await ok('http://169.254.169.254/latest/meta-data/');
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/not allowed/i);
    });

    it('blocks the link-local range and IPv6 link-local + IPv6 metadata', async () => {
      expect((await ok('http://169.254.1.1/')).ok).toBe(false);
      expect((await ok('http://[fe80::1]:11434/')).ok).toBe(false);
      expect((await ok('http://[fd00:ec2::254]/')).ok).toBe(false);
    });

    it('blocks the IPv4-mapped IPv6 form of the metadata IP (security review #1)', async () => {
      // WHATWG URL canonicalizes ::ffff:169.254.169.254 -> ::ffff:a9fe:a9fe (hex); both must block.
      expect((await ok('http://[::ffff:169.254.169.254]/latest/meta-data/')).ok).toBe(false);
      expect((await ok('http://[::ffff:a9fe:a9fe]/')).ok).toBe(false);
    });

    it('allows an IPv6 unique-local (ULA) address — that is an ordinary LAN, not metadata', async () => {
      expect((await ok('http://[fd12:3456::5]:11434/')).ok).toBe(true);
    });

    it('rejects a non-http(s) scheme', async () => {
      expect((await ok('file:///etc/passwd')).ok).toBe(false);
      expect((await ok('ftp://host/')).ok).toBe(false);
      expect((await ok('not a url')).ok).toBe(false);
    });
  });

  describe('loopback is narrowed to the Ollama port (item #542)', () => {
    it('allows loopback on the Ollama port — the bare-metal local case still works', async () => {
      expect((await ok('http://127.0.0.1:11434')).ok).toBe(true);
      expect((await ok('http://[::1]:11434')).ok).toBe(true);
      expect((await ok('http://[::ffff:127.0.0.1]:11434/')).ok).toBe(true);
    });

    it('DENIES loopback on any other port — that is this server, not the user machine', async () => {
      const r = await ok('http://127.0.0.1:8081/');
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/loopback/i);
      expect((await ok('http://localhost/')).ok).toBe(false); // implicit port 80
      expect((await ok('http://127.0.0.1:27017/')).ok).toBe(false);
    });

    it('honours a configured loopback port list, and an empty list denies loopback outright', async () => {
      mockEnv.agentOllamaLoopbackPorts = '11434,11435';
      expect((await ok('http://127.0.0.1:11435')).ok).toBe(true);
      mockEnv.agentOllamaLoopbackPorts = '';
      expect((await ok('http://127.0.0.1:11434')).ok).toBe(false);
    });

    it('applies the same rule to a NAME that resolves to loopback', async () => {
      expect((await ok('http://ollama.test:11434', resolvesTo('127.0.0.1'))).ok).toBe(true);
      expect((await ok('http://ollama.test:8081', resolvesTo('127.0.0.1'))).ok).toBe(false);
    });
  });

  describe('DNS resolution — the item #542 fix', () => {
    it('blocks a NAME that resolves to the cloud-metadata address', async () => {
      const r = await ok('http://ollama.evil.test:11434', resolvesTo('169.254.169.254'));
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/not allowed/i);
    });

    it('allows a NAME that resolves to an ordinary LAN address', async () => {
      expect((await ok('http://nas.home.arpa:11434', resolvesTo('192.168.1.50'))).ok).toBe(true);
    });

    it('checks EVERY answer, not just the first', async () => {
      // One public and one blocked answer is the shape that defeats a guard reading answers[0],
      // and it is trivially arranged by whoever controls the name.
      const r = await ok('http://split.test:11434', resolvesTo('203.0.113.9', '169.254.169.254'));
      expect(r.ok).toBe(false);
    });

    it('treats an unresolvable name, and a name with no answers, as NOT safe', async () => {
      const throws: OllamaLookup = async () => {
        throw new Error('ENOTFOUND');
      };
      expect((await ok('http://nope.test:11434', throws)).ok).toBe(false);
      expect((await ok('http://empty.test:11434', async () => [])).ok).toBe(false);
    });

    it('does not leak the resolver error into the user-facing reason', async () => {
      const throws: OllamaLookup = async () => {
        throw new Error('queryA ENOTFOUND ollama.internal.corp via 10.0.0.53');
      };
      const r = await ok('http://ollama.internal.corp:11434', throws);
      expect(r.ok).toBe(false);
      expect(r.reason).not.toMatch(/10\.0\.0\.53|queryA|ENOTFOUND/);
    });
  });

  describe('DNS rebinding — a host permitted at save and denied at use', () => {
    it('is caught because the check runs again at USE, against the answer of the moment', async () => {
      let call = 0;
      const rebinding: OllamaLookup = async () => {
        call += 1;
        return call === 1
          ? [{ address: '192.168.1.50', family: 4 }] // save time: an ordinary LAN Ollama
          : [{ address: '169.254.169.254', family: 4 }]; // use time: cloud metadata
      };
      expect((await ok('http://rebind.test:11434', rebinding)).ok).toBe(true);
      const atUse = await ok('http://rebind.test:11434', rebinding);
      expect(atUse.ok).toBe(false);
      expect(atUse.reason).toMatch(/not allowed/i);
    });
  });

  describe('allow-list', () => {
    it('enforces the allow-list when configured — only listed hosts pass', async () => {
      mockEnv.agentOllamaAllowedHosts = 'ollama.internal, 10.0.0.5';
      expect((await ok('http://ollama.internal:11434', resolvesTo('203.0.113.7'))).ok).toBe(true);
      expect((await ok('http://10.0.0.5:11434')).ok).toBe(true);
      const r = await ok('http://192.168.1.20:11434');
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/allow-list/i);
    });

    it('matches the allow-list EXACTLY — a suffix must not admit an attacker subdomain', async () => {
      mockEnv.agentOllamaAllowedHosts = 'nas.home.arpa';
      expect((await ok('http://nas.home.arpa.attacker.test:11434', resolvesTo('203.0.113.7'))).ok).toBe(false);
    });

    it('still blocks metadata even if someone allow-lists it', async () => {
      mockEnv.agentOllamaAllowedHosts = '169.254.169.254';
      expect((await ok('http://169.254.169.254/')).ok).toBe(false);
    });

    it('still blocks a NAME that is allow-listed but resolves to metadata', async () => {
      mockEnv.agentOllamaAllowedHosts = 'ollama.internal';
      const r = await ok('http://ollama.internal:11434', resolvesTo('169.254.169.254'));
      expect(r.ok).toBe(false);
    });
  });
});

describe('assertOllamaUrlAllowed', () => {
  beforeEach(() => {
    mockEnv.agentOllamaAllowedHosts = '';
    mockEnv.agentOllamaLoopbackPorts = '11434';
  });

  it('returns every vetted address so the caller can pin the connection to them', async () => {
    const vetted = await assertOllamaUrlAllowed('http://nas.home.arpa:11434', {
      lookup: resolvesTo('192.168.1.50', '192.168.1.51'),
    });
    expect(vetted.hostname).toBe('nas.home.arpa');
    expect(vetted.port).toBe(11434);
    expect(vetted.protocol).toBe('http:');
    expect(vetted.addresses.map((a) => a.address)).toEqual(['192.168.1.50', '192.168.1.51']);
  });

  it('throws a typed error carrying a safe reason', async () => {
    await expect(
      assertOllamaUrlAllowed('http://evil.test:11434', { lookup: resolvesTo('169.254.169.254') }),
    ).rejects.toBeInstanceOf(OllamaUrlNotAllowedError);
  });
});
