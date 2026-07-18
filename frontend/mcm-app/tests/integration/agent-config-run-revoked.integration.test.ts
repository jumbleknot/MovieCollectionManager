/**
 * T024a — revoked-credential-at-interaction-time fails user-safe, no leak (US2, spec Edge Cases).
 *
 * A credential can pass validate-on-save and later be revoked (the provider key is rotated/disabled
 * after it was stored). At run time the model call then fails. This test proves that failure is
 * USER-SAFE: the run terminates (no hang), surfaces a generic error to the user, and NEVER leaks the
 * stored secret or a raw provider error body into the streamed events, the resulting messages, or
 * the thrown error (FR-024 / SC-004 / SC-006).
 *
 * It plants a runnable config whose stored Anthropic key is a recognizable *invalid* marker — this
 * MUST be done by writing the encrypted blob directly via the store, because validate-on-save would
 * (correctly) reject the bad key at the PUT boundary; the "revoked after save" state only exists at
 * rest. The run is driven through the BFF's OWN gateway client (`createMovieAssistantAgent` → the
 * AG-UI `HttpAgent`) against the live gateway — the exact path `run+api` uses — carrying the
 * per-run `X-Agent-Config` the BFF builds from `resolveForRun`. The Anthropic provider is chosen so
 * the failure happens at the first (supervisor) model call, before any tool/TMDB call, and the
 * "secret" (the API key) is a real leak target.
 *
 * Requires the live gateway on 127.0.0.1:8123 (bring it up via `--profile agents-metro`) + Keycloak
 * token exchange (T012). Skips cleanly when token exchange is unconfigured (secret is gitignored,
 * never cassetted).
 *
 * Run: pnpm nx test:integration mcm-app -- --testPathPattern "agent-config-run-revoked"
 */
import { createMovieAssistantAgent } from '@/bff-server/agent-gateway-client';
import {
  mintSubjectToken,
  isSubjectTokenExchangeConfigured,
} from '@/bff-server/agent-subject-token';
import { resolveForRun } from '@/bff-server/agent-config-service';
import * as store from '@/bff-server/agent-config-store';
import { encryptSecret, secretAad } from '@/bff-server/agent-config-crypto';
import { getAgentConfigCollection, closeMongo } from '@/bff-server/mongo-client';
import { env } from '@/config/env';
import {
  ensureRopcAudienceMapper,
  ensureRopcAudienceFor,
  ensureClientAudienceMapper,
  createTestUser,
  deleteTestUser,
  getTestTokens,
  assignRole,
  type TestUser,
} from './helpers/keycloak-test-client';

// Recognizable markers planted as the stored secrets. If EITHER appears anywhere in the run's
// user-facing surface (events, messages, error), the safe-failure contract is broken.
const ANTHROPIC_MARKER = 'sk-ant-REVOKED-LEAK-MARKER-do-not-surface-9z9z9z';
const TMDB_MARKER = 'tmdb-REVOKED-LEAK-MARKER-9z9z9z';

const configured = isSubjectTokenExchangeConfigured();
const describeOrSkip = configured ? describe : describe.skip;

// Feature 041: this test drives the gateway DIRECTLY (createMovieAssistantAgent → AG-UI HttpAgent at
// AGENT_GATEWAY_URL). In app-e2e the gateway is BFF-fronted and NOT published to the host (its URL is
// the Docker-internal movie-assistant-gateway:8000), so a host-run test can't reach it → self-skip
// (legitimate: the gateway is an optional-to-host-expose dep here, like Ollama). In a dev env with
// `--profile agents-metro` the gateway is on 127.0.0.1:8123 and this runs.
const GATEWAY_URL = process.env.AGENT_GATEWAY_URL ?? 'http://localhost:8123';
async function isGatewayReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

if (!configured) {
  // eslint-disable-next-line no-console
  console.warn(
    'SKIP agent-config-run-revoked integration: set AGENT_SUBJECT_TOKEN_CLIENT_ID/_SECRET/_AUDIENCE ' +
      'in frontend/mcm-app/.env.local (T012 applied) + the live gateway on :8123 (`--profile agents-metro`) to run.',
  );
}

describeOrSkip('revoked credential at run time (real Mongo + live gateway)', () => {
  let user: TestUser;
  let userAccessToken: string;
  let gatewayReachable = false;

  const subjectClientId = process.env.AGENT_SUBJECT_TOKEN_CLIENT_ID ?? 'agent-subject-token';
  const gatewayAud = process.env.AGENT_SUBJECT_TOKEN_AUDIENCE ?? 'agent-gateway';

  beforeAll(async () => {
    await ensureRopcAudienceMapper();
    await ensureRopcAudienceFor(subjectClientId);
    await ensureClientAudienceMapper(subjectClientId, gatewayAud);
    user = await createTestUser('agentcfg-revoked');
    await assignRole(user.userId, 'mc-user');
    ({ accessToken: userAccessToken } = await getTestTokens(user.username, user.password));

    // Plant a RUNNABLE config whose stored Anthropic + TMDB keys are invalid markers. Direct store
    // write — the PUT validate-on-save path would reject these (that's the point: revoked AFTER save).
    await store.upsert(user.userId, {
      enabled: true,
      provider: 'anthropic',
      ollamaBaseUrl: null,
      anthropicKeyEnc: encryptSecret(ANTHROPIC_MARKER, env.agentConfigEncKey, secretAad(user.userId, 'anthropicKey')),
      tmdbKeyEnc: encryptSecret(TMDB_MARKER, env.agentConfigEncKey, secretAad(user.userId, 'tmdbKey')),
      costLimitUsd: null,
      updatedAt: new Date().toISOString(),
    });
    gatewayReachable = await isGatewayReachable(GATEWAY_URL);
  }, 40_000);

  afterAll(async () => {
    const col = await getAgentConfigCollection();
    await col.deleteMany({ _id: user?.userId });
    await closeMongo();
    await deleteTestUser(user?.userId);
  });

  it('fails user-safe and leaks no secret when the stored credential is invalid', async () => {
    if (!gatewayReachable) {
      console.warn(`SKIP: gateway not reachable at ${GATEWAY_URL} (BFF-fronted in app-e2e, not host-published)`);
      return;
    }
    // resolveForRun returns the decrypted (revoked) creds — runnable per isRunnable (enabled +
    // anthropicKeyEnc + tmdbKeyEnc), so the run proceeds to the gateway and fails at the model.
    const runConfig = await resolveForRun(user.userId);
    expect(runConfig).not.toBeNull();
    expect(runConfig!.anthropicKey).toBe(ANTHROPIC_MARKER); // decrypts in-memory (proves the plant)

    const { token: subjectToken } = await mintSubjectToken(userAccessToken);
    const agent = createMovieAssistantAgent({ agentConfig: runConfig!, subjectToken });
    agent.messages = [
      { id: 'u1', role: 'user', content: 'How many movies are in my collection?' },
    ];

    // Capture every streamed event so we can scan the entire user-facing surface for a leak.
    const events: unknown[] = [];
    let runFailedError: string | undefined;
    agent.subscribe({
      onEvent: ({ event }) => {
        events.push(event);
      },
      onRunFailed: ({ error }) => {
        runFailedError = String(error?.message ?? error);
      },
    });

    let threwError: string | undefined;
    let newMessages: unknown[] = [];
    try {
      const result = await agent.runAgent({ runId: 'revoked-run-1' });
      newMessages = result.newMessages;
    } catch (e) {
      // A failed run may reject (RunErrorEvent → throw) — that is an acceptable user-safe outcome
      // as long as nothing leaks. We assert on the error text below.
      threwError = e instanceof Error ? e.message : String(e);
    }

    // The run TERMINATED (no indefinite hang) — reaching here within the per-test timeout proves it.
    // Scan the entire user-facing surface: streamed events + resulting messages + any error.
    const surface = [
      JSON.stringify(events),
      JSON.stringify(newMessages),
      JSON.stringify(agent.messages),
      runFailedError ?? '',
      threwError ?? '',
    ].join('\n');

    // (1) Leak safety (SC-006): the stored secrets MUST NOT appear anywhere a user — or a log
    // scraping this surface — could see, in full or in part.
    expect(surface).not.toContain(ANTHROPIC_MARKER);
    expect(surface).not.toContain(TMDB_MARKER);
    expect(surface).not.toContain('REVOKED-LEAK-MARKER');

    // (2) User-safe surfacing: the failure is rendered as a bounded, generic assistant message
    // (the gateway catches the revoked-credential model error and degrades to a safe decline rather
    // than a loud error or a silent fabricated answer). The user must get SOME feedback…
    const assistantText = (agent.messages as Array<{ role?: string; content?: unknown }>)
      .filter((m) => m.role === 'assistant')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(assistantText.trim().length).toBeGreaterThan(0);

    // …and that feedback must carry NO raw provider/internal detail (no status code, provider name,
    // key-shaped token, stack trace, or upstream URL) — only a safe, generic message.
    const lowered = assistantText.toLowerCase();
    for (const internal of [
      'anthropic', 'api_key', 'api-key', 'x-api-key', 'sk-ant', '401', 'unauthorized',
      'traceback', 'exception', 'httpx', 'econnrefused', 'http://', 'https://',
    ]) {
      expect(lowered).not.toContain(internal);
    }
  }, 60_000);
});
