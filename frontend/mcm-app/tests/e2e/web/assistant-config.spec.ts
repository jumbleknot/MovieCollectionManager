/**
 * T014 / T024 (web E2E): per-user movie assistant configuration (feature 018).
 *
 * Proves the opt-in + bring-your-own-credentials contract on real react-native-web DOM:
 *   - T014 (US1): a fresh/unconfigured user gets NO dock (gated on a runnable config — T018) and a
 *     forced `POST /bff-api/agent/run` short-circuits with the typed `assistant_not_configured`
 *     marker — no model call, no cost (SC-001/SC-002).
 *   - T024a (US2): enabling + choosing Ollama + supplying the provider URL and a TMDB key, then
 *     Save, makes the dock appear and a real assistant interaction succeed USING those per-user
 *     credentials (X-Agent-Config → gateway model + TMDB) — the end-to-end per-run injection proof.
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

import { test, expect, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';
import {
  seedAgentConfig,
  clearAgentConfig,
  SEED_OLLAMA_URL,
  SEED_TMDB_KEY,
} from './setup/agent-config-seed';

// Only meaningful against the live gateway with a TMDB key available to seed/configure.
const PRODUCTION = process.env['E2E_AGENT_PRODUCTION'] === '1' && SEED_TMDB_KEY !== '';

// LLM round-trip through Ollama on top of a possible cold-compile — generous, mirrors assistant.spec.
const ASSISTANT_REPLY_TIMEOUT = 90_000;

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

  test('off by default: unconfigured user has no dock and a run short-circuits', async ({ page }) => {
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

  test('configure (Ollama + TMDB) + save → dock appears → an interaction succeeds on my creds', async ({ page }) => {
    await clearAgentConfig(page.request);
    await gotoProfile(page);

    // Enable, pick Ollama, supply the (container-reachable) base URL + the user's own TMDB key.
    // After clearAgentConfig the form loads enabled=false deterministically, so one click enables it.
    await page.click('[data-testid="assistant-config-enabled-toggle"]');
    await page.click('[data-testid="assistant-config-provider-ollama"]');
    await page.fill('[data-testid="assistant-config-ollama-url-input"]', SEED_OLLAMA_URL);
    await page.fill('[data-testid="assistant-config-tmdb-key-input"]', SEED_TMDB_KEY);
    await page.click('[data-testid="assistant-config-save"]');

    // Validate-on-save probed the live creds and persisted → success banner.
    const banner = page.locator('[data-testid="assistant-config-banner"]');
    await expect(banner).toBeVisible({ timeout: 20000 });
    await expect(banner).toContainText(/saved/i);

    // The dock now renders, and a real interaction streams a reply using the per-user creds.
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

  test('test connection re-probes the saved credentials with no re-entry', async ({ page }) => {
    // Start from the known-good seeded config (Ollama + TMDB on file) — no secret re-entered.
    await seedAgentConfig(page.request);
    await gotoProfile(page);

    await page.click('[data-testid="assistant-test-connection"]');

    const results = page.locator('[data-testid="assistant-config-test-results"]');
    await expect(results).toBeVisible({ timeout: 20000 });
    // Per-credential status rows report OK for the stored Ollama URL + TMDB key.
    await expect(page.locator('[data-testid="assistant-config-test-ollama"]')).toContainText(/ok/i);
    await expect(page.locator('[data-testid="assistant-config-test-tmdb"]')).toContainText(/ok/i);
  });

  test('disable → dock disappears + run short-circuits; re-open retains the provider', async ({ page }) => {
    // Start from the seeded runnable config (enabled, Ollama + TMDB on file).
    await seedAgentConfig(page.request);
    await gotoProfile(page);

    // Toggle the assistant off and save (disable keeps non-secret settings; secrets retained).
    await page.click('[data-testid="assistant-config-enabled-toggle"]');
    await page.click('[data-testid="assistant-config-save"]');
    const banner = page.locator('[data-testid="assistant-config-banner"]');
    await expect(banner).toBeVisible({ timeout: 20000 });
    await expect(banner).toContainText(/saved/i);

    // The dock is gone and a forced run short-circuits (gated on a runnable config — T018/T016).
    await gotoHome(page);
    await expect(page.locator('[data-testid="assistant-dock-toggle"]')).toHaveCount(0);
    const res = await page.request.post('/bff-api/agent/run', {
      data: { operationName: 'generateCopilotResponse' },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ type: 'assistant_not_configured' });

    // Re-open profile: the provider selection + non-secret URL are retained across the disable.
    await gotoProfile(page);
    await expect(page.locator('[data-testid="assistant-config-provider-ollama"]')).toBeVisible();
    await expect(page.locator('[data-testid="assistant-config-ollama-url-input"]')).toHaveValue(SEED_OLLAMA_URL);
  });

  test('a personal cost limit short-circuits runs once the accrued cost exceeds it', async ({ page }) => {
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

  test('a bad Anthropic key is rejected per-field and nothing is persisted', async ({ page }) => {
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
