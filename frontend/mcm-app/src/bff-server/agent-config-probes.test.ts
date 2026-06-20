// Unit tests for the credential probes (feature 018). fetch is mocked — no live network.
// Focus: the probe NEVER echoes a secret (review #8), uses redirect:'manual' (review #3), and
// probeOllama short-circuits a blocked SSRF target before any fetch.

jest.mock('@/config/env', () => ({ env: { agentOllamaAllowedHosts: '' } }));

import { probeOllama, probeTmdb, probeAnthropic } from './agent-config-probes';

const mockFetch = jest.fn();
beforeEach(() => {
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;
});

function res(init: { ok: boolean; status: number }): Response {
  return { ok: init.ok, status: init.status } as Response;
}

describe('probeTmdb — never leaks the key (review #8)', () => {
  it('returns a safe reason on 401 that does not contain the key', async () => {
    mockFetch.mockResolvedValue(res({ ok: false, status: 401 }));
    const status = await probeTmdb('super-secret-tmdb-key');
    expect(status).not.toBe('ok');
    const reason = typeof status === 'object' ? status.reason : '';
    expect(reason).not.toContain('super-secret-tmdb-key');
    expect(reason).toMatch(/invalid key/i);
  });

  it('returns a safe reason on a network error that does not contain the key', async () => {
    mockFetch.mockRejectedValue(new Error('connect ECONNREFUSED super-secret-tmdb-key'));
    const status = await probeTmdb('super-secret-tmdb-key');
    const reason = typeof status === 'object' ? status.reason : '';
    expect(reason).toBe('Could not reach the TMDB API');
    expect(reason).not.toContain('super-secret-tmdb-key');
  });

  it('uses redirect:manual on the probe fetch (review #3)', async () => {
    mockFetch.mockResolvedValue(res({ ok: true, status: 200 }));
    await probeTmdb('k');
    expect(mockFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'manual' }));
  });
});

describe('probeAnthropic — never leaks the key', () => {
  it('returns a safe reason on 401 without echoing the key', async () => {
    mockFetch.mockResolvedValue(res({ ok: false, status: 401 }));
    const status = await probeAnthropic('sk-ant-secret');
    const reason = typeof status === 'object' ? status.reason : '';
    expect(reason).not.toContain('sk-ant-secret');
  });
});

describe('probeOllama — SSRF short-circuit (review #3)', () => {
  it('rejects a cloud-metadata URL WITHOUT any fetch', async () => {
    const status = await probeOllama('http://169.254.169.254/');
    expect(status).not.toBe('ok');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('probes an allowed loopback URL (fetch IS called)', async () => {
    mockFetch.mockResolvedValue(res({ ok: true, status: 200 }));
    expect(await probeOllama('http://localhost:11434')).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
