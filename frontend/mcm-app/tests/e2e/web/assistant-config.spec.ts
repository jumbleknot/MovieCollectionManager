/**
 * T014 / T024 (web E2E): per-user movie assistant configuration (feature 018).
 *
 * Proves the opt-in + bring-your-own-credentials contract on real react-native-web DOM:
 *   - T014 (US1): a fresh/unconfigured user gets NO dock (gated on a runnable config — T018) and a
 *     forced `POST /bff-api/agent/run` short-circuits with the typed `assistant_not_configured`
 *     marker — no model call, no cost (SC-001/SC-002).
 *   - T024a (US2): enabling + choosing the provider + supplying its credential and a TMDB key, then
 *     Save, makes the dock appear and a real assistant interaction succeed USING those per-user
 *     credentials (X-Agent-Config → gateway model + TMDB) — the end-to-end per-run injection proof.
 *     The provider follows `SEED_PROVIDER` (E2E_AGENT_PROVIDER): Ollama in the dev container,
 *     Anthropic in CI. It used to be hard-coded to Ollama, which made three of these tests
 *     unpassable in CI for an environmental reason — see `fillProviderCredential` below.
 *   - T024b (US2): a bad Anthropic key is rejected per-field (422 surfaced inline) and nothing is
 *     persisted (GET still reports unconfigured).
 *
 * These run only against the live containerized gateway with a real TMDB key to seed/configure
 * (E2E_AGENT_PRODUCTION=1) — i.e. via `node scripts/agent-e2e.mjs assistant-config`. The global
 * setup seeds a runnable config by default (T050); each test here clears it to a known state and
 * `afterEach` re-seeds so the rest of the assistant suite (which assumes a dock) is unaffected.
 *
 * Run (isolated):  node scripts/agent-e2e.mjs assistant-config
 */

import { test, expect } from './fixtures/worker-session';
import { type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import {
  seedAgentConfig,
  clearAgentConfig,
  agentSeedingEnabled,
  SEED_OLLAMA_URL,
  SEED_TMDB_KEY,
  SEED_PROVIDER,
  SEED_ANTHROPIC_KEY,
} from './setup/agent-config-seed';

// Only meaningful against the live gateway with credentials the harness can actually seed.
// `agentSeedingEnabled()` is the same gate global-setup uses, so this describe runs exactly when a
// runnable config can exist — for ollama that means E2E_AGENT_PRODUCTION + TMDB, for anthropic a
// key + TMDB. Deriving it (rather than re-testing TMDB here) is what keeps this from skipping for
// a reason global-setup does not share.
const PRODUCTION = process.env['E2E_AGENT_PRODUCTION'] === '1' && agentSeedingEnabled();

// LLM round-trip on top of a possible cold-compile — generous, mirrors assistant.spec.
const ASSISTANT_REPLY_TIMEOUT = 90_000;

/**
 * Type the credential the SEEDED provider needs into the form.
 *
 * These tests used to hard-code the Ollama pair (chip → base-URL input → probe reports `ollama`).
 * That is not a property of feature 018 — it is a property of the machine the suite happened to be
 * developed on. `app-e2e` runs `E2E_AGENT_PROVIDER=anthropic` against a stack with no Ollama
 * anywhere (the workflow deliberately does not forward `E2E_AGENT_OLLAMA_URL`), so validate-on-save
 * probed `host.docker.internal:11434`, failed, and the banner read "Some settings could not be
 * validated" instead of "Saved" — three failures in backlog #150 cluster B that were never a
 * product defect. The dev container CAN reach Ollama (the nested `dev-ollama` container), so the
 * Ollama path still gets exercised locally; parametrising here is what lets BOTH surfaces run the
 * same assertions at full strength rather than skipping one of them.
 */
async function fillProviderCredential(page: Page): Promise<void> {
  await page.click(`[data-testid="assistant-config-provider-${SEED_PROVIDER}"]`);
  if (SEED_PROVIDER === 'ollama') {
    await page.fill('[data-testid="assistant-config-ollama-url-input"]', SEED_OLLAMA_URL);
  } else {
    await page.fill('[data-testid="assistant-config-anthropic-key-input"]', SEED_ANTHROPIC_KEY);
  }
}

/** Land on /home with the inherited session, tolerating the FR-009 default-collection redirect. */
async function gotoHome(page: Page): Promise<void> {
  await page.goto(`${BASE}/home`);
  const result = await Promise.race([
    page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 }).then(() => 'home' as const),
    page.waitForSelector('[data-testid="collection-screen-add-movie"]', { state: 'visible', timeout: 60000 }).then(() => 'collection' as const),
  ]).catch(() => null);
  if (result === 'collection') {
    await page.goto(`${BASE}/home`);
    await page.waitForSelector('[data-testid="home-screen-create-button"]', { state: 'visible', timeout: 60000 });
    return;
  }
  if (!result) throw new Error('gotoHome: home screen did not render — is the global-setup session valid?');
}

/** Open the profile screen and wait for the assistant config form to mount. */
async function gotoProfile(page: Page): Promise<void> {
  await page.goto(`${BASE}/profile`);
  await page.waitForSelector('[data-testid="profile-screen"]', { state: 'visible', timeout: 60000 });
  await page.waitForSelector('[data-testid="assistant-config"]', { state: 'visible', timeout: 60000 });
  // The form hydrates from the server view; wait out the loading placeholder.
  await page.waitForSelector('[data-testid="assistant-config-loading"]', { state: 'detached', timeout: 15000 }).catch(() => {});
}

async function openDock(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="assistant-dock-toggle"]', { state: 'visible', timeout: 60000 });
  await page.click('[data-testid="assistant-dock-toggle"]');
  await page.waitForSelector('[data-testid="assistant-dock-panel"]', { state: 'visible', timeout: 10000 });
}

test.describe('Assistant per-user config (feature 018)', () => {
  test.skip(!PRODUCTION, 'requires E2E_AGENT_PRODUCTION=1 + a TMDB key to seed (live gateway)');

  // Restore the configured default after every test so the rest of the assistant suite (which
  // assumes a runnable dock) is unaffected by the clear/configure mutations here. costLimitUsd is
  // explicitly nulled so the cost-limit test's tiny ceiling never leaks into later specs (a reseed
  // that OMITS costLimitUsd would keep the stored value — FR-014).
  test.afterEach(async ({ page }) => {
    await seedAgentConfig(page.request, { costLimitUsd: null });
  });

  test('off by default: unconfigured user has no dock and a run short-circuits', { tag: '@gate' }, async ({ page }) => {
    await clearAgentConfig(page.request);
    await gotoHome(page);

    // The dock is gated on a runnable config (T018) → the toggle is not mounted at all.
    await expect(page.locator('[data-testid="assistant-dock-toggle"]')).toHaveCount(0);

    // A forced billable run short-circuits BEFORE any gateway/model call or cost accrual.
    const res = await page.request.post('/bff-api/agent/run', {
      data: { operationName: 'generateCopilotResponse' },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ type: 'assistant_not_configured' });
  });

  test('configure (provider + TMDB) + save → dock appears → an interaction succeeds on my creds', { tag: '@gate' }, async ({ page }) => {
    await clearAgentConfig(page.request);
    await gotoProfile(page);

    // Enable, pick the harness provider, supply its credential + the user's own TMDB key.
    // After clearAgentConfig the form loads enabled=false deterministically, so one click enables it.
    await page.click('[data-testid="assistant-config-enabled-toggle"]');
    await fillProviderCredential(page);
    await page.fill('[data-testid="assistant-config-tmdb-key-input"]', SEED_TMDB_KEY);
    await page.click('[data-testid="assistant-config-save"]');

    // Validate-on-save probed the live creds and persisted → success banner.
    const banner = page.locator('[data-testid="assistant-config-banner"]');
    await expect(banner).toBeVisible({ timeout: 20000 });
    await expect(banner).toContainText(/saved/i);

    // FR-031 / SC-012: the dock appears IN-SESSION on save — no reload / re-login. Assert the
    // toggle becomes visible while STILL on the profile screen (NO page.goto between save and
    // this check), so it is the shared-state refresh, not a layout remount, that surfaces the
    // dock. (This assertion fails on the pre-fix per-component-copy bug.)
    await expect(page.locator('[data-testid="assistant-dock-toggle"]')).toBeVisible({ timeout: 15000 });

    // The dock also works after navigation: a real interaction streams a reply on the per-user creds.
    await gotoHome(page);
    await openDock(page);
    const prompt = 'How many movies are in my collection?';
    await page.fill('[data-testid="assistant-dock-input"]', prompt);
    await page.click('[data-testid="assistant-dock-send"]');

    const userMsg = page.locator('[data-testid="assistant-msg-user"]').last();
    await expect(userMsg).toContainText(prompt);
    const assistantMsg = page.locator('[data-testid="assistant-msg-assistant"]').last();
    await expect(assistantMsg).toBeVisible({ timeout: ASSISTANT_REPLY_TIMEOUT });
    await expect(assistantMsg).not.toBeEmpty();
  });

  test('test connection re-probes the saved credentials with no re-entry', { tag: '@gate' }, async ({ page }) => {
    // Start from the known-good seeded config (provider credential + TMDB on file) — nothing re-entered.
    await seedAgentConfig(page.request);
    await gotoProfile(page);

    await page.click('[data-testid="assistant-test-connection"]');

    const results = page.locator('[data-testid="assistant-config-test-results"]');
    await expect(results).toBeVisible({ timeout: 20000 });
    // Per-credential status rows report OK. `testStored` keys each row on the credential it found
    // on file (`ollama` / `anthropic` / `tmdb`), so the provider row's testID follows the seed.
    await expect(page.locator(`[data-testid="assistant-config-test-${SEED_PROVIDER}"]`)).toContainText(/ok/i);
    await expect(page.locator('[data-testid="assistant-config-test-tmdb"]')).toContainText(/ok/i);
  });

  test('disable → dock disappears + run short-circuits; re-open retains the provider', { tag: '@gate' }, async ({ page }) => {
    // Start from the seeded runnable config (enabled, provider credential + TMDB on file).
    await seedAgentConfig(page.request);
    await gotoProfile(page);

    // Toggle the assistant off and save. The config is runnable here so the bottom-left dock is
    // mounted; the form's action row is right-aligned (DS convention) so the dock never intercepts.
    await page.click('[data-testid="assistant-config-enabled-toggle"]');
    await page.click('[data-testid="assistant-config-save"]');
    const banner = page.locator('[data-testid="assistant-config-banner"]');
    await expect(banner).toBeVisible({ timeout: 20000 });
    await expect(banner).toContainText(/saved/i);

    // FR-031 / SC-012: disabling takes effect IN-SESSION — the dock disappears with no reload /
    // re-login. Assert the toggle unmounts while STILL on the profile screen (NO page.goto), so
    // the shared-state refresh, not a remount, is what hides it. (Fails on the pre-fix bug, where
    // the stale dock lingered until re-login.)
    await expect(page.locator('[data-testid="assistant-dock-toggle"]')).toHaveCount(0, { timeout: 15000 });

    // After navigation it stays gone and a forced run short-circuits (gated on a runnable config).
    await gotoHome(page);
    await expect(page.locator('[data-testid="assistant-dock-toggle"]')).toHaveCount(0);
    const res = await page.request.post('/bff-api/agent/run', {
      data: { operationName: 'generateCopilotResponse' },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ type: 'assistant_not_configured' });

    // Re-open profile: the provider selection is retained across the disable. Assert it via the
    // credential block, which the form renders FROM the stored provider — both provider chips are
    // always mounted, so a chip locator would have passed whichever provider came back.
    await gotoProfile(page);
    if (SEED_PROVIDER === 'ollama') {
      await expect(page.locator('[data-testid="assistant-config-ollama-url-input"]')).toHaveValue(SEED_OLLAMA_URL);
      await expect(page.locator('[data-testid="assistant-config-anthropic-key-input"]')).toHaveCount(0);
    } else {
      // The key itself is never returned (FR-018); the "(configured)" label is how the form says
      // one is on file, so it is the only retained-secret evidence the client can legitimately see.
      await expect(page.locator('[data-testid="assistant-config-anthropic-key-input"]')).toBeVisible();
      await expect(page.locator('[data-testid="assistant-config-ollama-url-input"]')).toHaveCount(0);
      await expect(page.getByTestId('assistant-config')).toContainText('Anthropic API key (configured)');
    }
  });

  test('a personal cost limit short-circuits runs once the accrued cost exceeds it', { tag: '@gate' }, async ({ page }) => {
    // Seed a runnable config with a tiny personal ceiling ($0.01) — at/below the per-turn estimate,
    // so a billable run trips the ceiling within a couple of turns (US5 override → enforceAgentCostCeiling).
    await seedAgentConfig(page.request, { costLimitUsd: 0.01 });

    // Drive billable runs directly. The per-turn cost estimate accrues server-side BEFORE the gateway
    // call, so even a minimal body counts a turn; the pre-flight ceiling check then short-circuits with
    // a 429 (RateLimitError) once accrued cost reaches the ceiling — no model call, no action.
    let status = 0;
    for (let i = 0; i < 5 && status !== 429; i++) {
      const res = await page.request.post('/bff-api/agent/run', {
        data: { operationName: 'generateCopilotResponse' },
      });
      status = res.status();
    }
    expect(status).toBe(429);
  });

  test('a bad Anthropic key is rejected per-field and nothing is persisted', { tag: '@gate' }, async ({ page }) => {
    await clearAgentConfig(page.request);
    await gotoProfile(page);

    await page.click('[data-testid="assistant-config-enabled-toggle"]');
    await page.click('[data-testid="assistant-config-provider-anthropic"]');
    await page.fill('[data-testid="assistant-config-anthropic-key-input"]', 'sk-ant-definitely-not-a-real-key');
    await page.fill('[data-testid="assistant-config-tmdb-key-input"]', SEED_TMDB_KEY);
    await page.click('[data-testid="assistant-config-save"]');

    // Per-field error surfaced inline; the safe reason never echoes the bad key.
    const fieldError = page.locator('[data-testid="assistant-config-anthropic-key-error"]');
    await expect(fieldError).toBeVisible({ timeout: 20000 });
    await expect(fieldError).not.toContainText('sk-ant-definitely-not-a-real-key');

    // Nothing persisted — the server view is still unconfigured.
    const res = await page.request.get('/bff-api/agent/config');
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false });
  });
});
