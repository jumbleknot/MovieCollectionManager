// The 400-vs-422 staging of `validateAndSave` (feature 018 FR-012/013; regression guard, item #542).
//
// WHY THIS FILE EXISTS. `validateAndSave` is staged, and the stages have different status codes:
// shape/enum/type problems are a 400, live probe failures are a 422. That split is part of the API
// contract and the UI depends on it.
//
// Item #542 broke it. Making the SAVE-time SSRF guard resolve DNS put a name lookup inside the
// SHAPE stage, so a host that merely failed to resolve came back 400 instead of reaching the probe
// and coming back 422. It was caught by `agent-config-save.integration.test.ts` in CI -- where
// `host.docker.internal` has no address -- and not by any unit test, because no unit test covered
// this function. That gap is what this file closes: the integration suite needs a live BFF,
// Keycloak and Mongo, so it is a slow and distant place to learn about a staging bug.
//
// The SSRF module is deliberately NOT mocked. It is the thing that regressed.

jest.mock('@/config/env', () => ({
  env: {
    agentOllamaAllowedHosts: '',
    agentOllamaLoopbackPorts: '11434',
    agentConfigEncKey: 'x'.repeat(44),
  },
}));
jest.mock('@/bff-server/agent-config-store');
jest.mock('@/bff-server/agent-config-probes');
jest.mock('@/bff-server/agent-config-crypto');

import * as store from '@/bff-server/agent-config-store';
import { probeOllama, probeTmdb, probeAnthropic } from '@/bff-server/agent-config-probes';
import { encryptSecret, secretAad } from '@/bff-server/agent-config-crypto';
import { validateAndSave } from '@/bff-server/agent-config-service';

const mockStore = store as jest.Mocked<typeof store>;
const mockProbeOllama = probeOllama as jest.MockedFunction<typeof probeOllama>;
const mockProbeTmdb = probeTmdb as jest.MockedFunction<typeof probeTmdb>;
const mockProbeAnthropic = probeAnthropic as jest.MockedFunction<typeof probeAnthropic>;

const USER = 'user-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.getByUserId.mockResolvedValue(null);
  mockStore.upsert.mockImplementation(async (_id, patch) => ({ _id: USER, ...patch }) as never);
  (encryptSecret as jest.Mock).mockReturnValue('enc');
  (secretAad as jest.Mock).mockReturnValue('aad');
  mockProbeOllama.mockResolvedValue('ok');
  mockProbeTmdb.mockResolvedValue('ok');
  mockProbeAnthropic.mockResolvedValue('ok');
});

describe('validateAndSave — a reachability problem is a 422, not a 400', () => {
  it('THE REGRESSION: an unresolvable Ollama host reaches the probe stage and reports 422', async () => {
    // `host.docker.internal` does not resolve on a CI runner. It is a perfectly well-formed URL,
    // so the shape stage must pass it through and let the probe be the thing that fails.
    mockProbeTmdb.mockResolvedValue({ reason: 'Authentication failed (invalid key)' });
    mockProbeOllama.mockResolvedValue({ reason: 'Could not reach the Ollama server at that URL' });

    const result = await validateAndSave(USER, {
      enabled: true,
      provider: 'ollama',
      ollamaBaseUrl: 'http://host.docker.internal:11434',
      tmdbKey: 'bad-key-xyz',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(422);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'tmdbKey' })]),
    );
    // The shape stage must not have short-circuited: the probes are proof it got past stage 1.
    expect(mockProbeTmdb).toHaveBeenCalled();
    expect(mockProbeOllama).toHaveBeenCalled();
    // And nothing was persisted.
    expect(mockStore.upsert).not.toHaveBeenCalled();
  });

  it('a name that would resolve somewhere blocked is still a 422, via the probe', async () => {
    // The save path does not resolve, so the guard cannot reject this at stage 1 -- and must not.
    // probeOllama resolves, refuses, and reports it as a per-field probe failure.
    mockProbeOllama.mockResolvedValue({
      reason: 'That address is not allowed (link-local / cloud-metadata range)',
    });

    const result = await validateAndSave(USER, {
      enabled: true,
      provider: 'ollama',
      ollamaBaseUrl: 'http://evil.test:11434',
      tmdbKey: 'good-key',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(422);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'ollamaBaseUrl' })]),
    );
    expect(mockStore.upsert).not.toHaveBeenCalled();
  });
});

describe('validateAndSave — what IS still a 400, decided without the network', () => {
  it.each([
    ['a blocked literal address', 'http://169.254.169.254:11434'],
    ['an IPv4-mapped metadata literal', 'http://[::ffff:a9fe:a9fe]:11434'],
    ['loopback on a non-Ollama port', 'http://127.0.0.1:8081'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['not a URL at all', 'nonsense'],
  ])('%s → 400 at the shape stage, no probe attempted', async (_label, ollamaBaseUrl) => {
    const result = await validateAndSave(USER, {
      enabled: true,
      provider: 'ollama',
      ollamaBaseUrl,
      tmdbKey: 'good-key',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.status).toBe(400);
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'ollamaBaseUrl' })]),
    );
    // Stage 1 short-circuits: a blocked URL is never probed, so it is never fetched.
    expect(mockProbeOllama).not.toHaveBeenCalled();
    expect(mockProbeTmdb).not.toHaveBeenCalled();
    expect(mockStore.upsert).not.toHaveBeenCalled();
  });
});

describe('validateAndSave — the happy path still saves', () => {
  it('an ordinary LAN Ollama URL with passing probes persists', async () => {
    const result = await validateAndSave(USER, {
      enabled: true,
      provider: 'ollama',
      ollamaBaseUrl: 'http://192.168.1.50:11434',
      tmdbKey: 'good-key',
    });
    expect(result.ok).toBe(true);
    expect(mockStore.upsert).toHaveBeenCalled();
  });
});
