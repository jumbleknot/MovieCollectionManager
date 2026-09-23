// Unit tests for the credential probes (feature 018).
//
// The Anthropic and TMDB probes hit fixed public URLs and still go through a MOCKED fetch — focus
// there is that a probe NEVER echoes a secret (review #8) and that a transient 5xx is retried.
//
// probeOllama no longer uses fetch at all (item #542): it resolves the URL, checks every answer,
// and issues the GET over a socket PINNED to those answers. So its tests run against a real
// loopback server rather than a mock — a pinned agent is exactly the thing a fetch mock cannot
// exercise, and mocking it would have proved nothing about the property that matters.

jest.mock('@/config/env', () => ({
  env: { agentOllamaAllowedHosts: '', agentOllamaLoopbackPorts: '11434' },
}));

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { env } from '@/config/env';
import { probeOllama, probeTmdb, probeAnthropic, PROBE_MAX_ATTEMPTS } from './agent-config-probes';
import type { OllamaLookup } from './agent-config-ssrf';

const mockEnv = env as unknown as {
  agentOllamaAllowedHosts: string;
  agentOllamaLoopbackPorts: string;
};

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

describe('probe retries a transient upstream 5xx (TMDB 502 gateway blip)', () => {
  it('retries a 502 then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(res({ ok: false, status: 502 }))
      .mockResolvedValueOnce(res({ ok: false, status: 502 }))
      .mockResolvedValueOnce(res({ ok: true, status: 200 }));
    const status = await probeTmdb('k');
    expect(status).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('gives up after PROBE_MAX_ATTEMPTS on a persistent 503 and returns a safe reason', async () => {
    mockFetch.mockResolvedValue(res({ ok: false, status: 503 }));
    const status = await probeTmdb('super-secret-tmdb-key');
    expect(mockFetch).toHaveBeenCalledTimes(PROBE_MAX_ATTEMPTS);
    const reason = typeof status === 'object' ? status.reason : '';
    expect(reason).toBe('TMDB responded 503');
    expect(reason).not.toContain('super-secret-tmdb-key');
  });

  it('does NOT retry a deterministic 401', async () => {
    mockFetch.mockResolvedValue(res({ ok: false, status: 401 }));
    await probeTmdb('k');
    expect(mockFetch).toHaveBeenCalledTimes(1);
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

describe('probeOllama — guard, then a pinned request (review #3, item #542)', () => {
  /** A one-shot loopback server standing in for Ollama. Returns its port and the paths it saw. */
  function startOllamaStub(status = 200): Promise<{
    port: number;
    paths: string[];
    close: () => Promise<void>;
  }> {
    const paths: string[] = [];
    const server = http.createServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(status);
      res.end('{"models":[]}');
    });
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve({
          port: (server.address() as AddressInfo).port,
          paths,
          close: () => new Promise<void>((done) => server.close(() => done())),
        });
      });
    });
  }

  beforeEach(() => {
    mockEnv.agentOllamaAllowedHosts = '';
    mockEnv.agentOllamaLoopbackPorts = '11434';
  });

  it('rejects a cloud-metadata URL without making any request at all', async () => {
    const status = await probeOllama('http://169.254.169.254/');
    expect(status).not.toBe('ok');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a NAME that resolves to cloud metadata — the item #542 case', async () => {
    const rebound: OllamaLookup = async () => [{ address: '169.254.169.254', family: 4 }];
    const status = await probeOllama('http://ollama.evil.test:11434/', { lookup: rebound });
    expect(status).not.toBe('ok');
    expect(typeof status === 'object' && status.reason).toMatch(/not allowed/i);
  });

  it('reaches an allowed server and appends /api/tags', async () => {
    const stub = await startOllamaStub(200);
    mockEnv.agentOllamaLoopbackPorts = String(stub.port);
    try {
      expect(await probeOllama(`http://127.0.0.1:${stub.port}`)).toBe('ok');
      expect(stub.paths).toEqual(['/api/tags']);
    } finally {
      await stub.close();
    }
  });

  it('preserves a base path rather than discarding it', async () => {
    const stub = await startOllamaStub(200);
    mockEnv.agentOllamaLoopbackPorts = String(stub.port);
    try {
      expect(await probeOllama(`http://127.0.0.1:${stub.port}/ollama/`)).toBe('ok');
      expect(stub.paths).toEqual(['/ollama/api/tags']);
    } finally {
      await stub.close();
    }
  });

  it('reports a non-2xx as a safe reason carrying only the status', async () => {
    const stub = await startOllamaStub(404);
    mockEnv.agentOllamaLoopbackPorts = String(stub.port);
    try {
      const status = await probeOllama(`http://127.0.0.1:${stub.port}`);
      expect(status).toEqual({ reason: 'Ollama responded 404' });
    } finally {
      await stub.close();
    }
  });

  it('returns a safe reason when nothing is listening, naming no address', async () => {
    // Port 1 on loopback: reliably refused, and nothing is ever bound there.
    mockEnv.agentOllamaLoopbackPorts = '1';
    const status = await probeOllama('http://127.0.0.1:1');
    expect(status).not.toBe('ok');
    const reason = typeof status === 'object' ? status.reason : '';
    expect(reason).toMatch(/could not reach/i);
    expect(reason).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
  });

  it('the socket goes to the VETTED address, not to whatever DNS says at connect time', async () => {
    const stub = await startOllamaStub(200);
    mockEnv.agentOllamaLoopbackPorts = String(stub.port);
    try {
      // The guard is told the name resolves to the stub. Node's own resolver has never heard of
      // `pinned.test`, so the request can only succeed if the pinned lookup is what supplied the
      // address — which is the whole property under test.
      const lookup: OllamaLookup = async () => [{ address: '127.0.0.1', family: 4 }];
      expect(await probeOllama(`http://pinned.test:${stub.port}`, { lookup })).toBe('ok');
      expect(stub.paths).toEqual(['/api/tags']);
    } finally {
      await stub.close();
    }
  });
});
