/**
 * T029 / T014a (web E2E): Conversational assistant dock via Playwright.
 *
 * Proves the feature-012 assistant end-to-end on real react-native-web DOM in a browser:
 *   - the app-wide dock overlay renders for an authenticated user (FR-001) and is
 *     reachable from any screen (clarify round 1);
 *   - opening it mounts the CopilotKit panel; closing it unmounts (no backend run while closed);
 *   - sending a message drives the live path — CopilotKit client → BFF CopilotKit-runtime
 *     bridge → AG-UI-native gateway → LangGraph (Ollama) — and the streamed AG-UI assistant
 *     reply renders inline (FR-004, SC-001 web leg).
 *
 * Unlike the unit render test (react-test-renderer, not a browser), this validates
 * CopilotKit rendering + SSE transport on actual react-native-web DOM.
 *
 * Requires the FULL stack running (see HANDOFF.md "Bring up the stack"):
 *   Ollama (qwen2.5) + Agent Gateway (:8123) + Keycloak + Redis + mc-service + Expo web (:8081).
 * Session is inherited from the Playwright global setup (storageState) — no per-test login.
 * The current graph is tool-free (no mc-service write), so no domain teardown is needed.
 *
 * Run (isolated):  pnpm nx e2e mcm-app -- tests/e2e/web/assistant.spec.ts
 */

import { test, expect, type Page } from '@playwright/test';

import { E2E_BASE_URL as BASE } from './setup/target';

// LLM round-trip through Ollama on top of a possible Metro cold-compile — give the
// assistant reply a generous budget (mirrors the 60 s cold-compile budget elsewhere).
const ASSISTANT_REPLY_TIMEOUT = 90_000;

/**
 * Navigate to /home using the inherited session (storageState; global setup logs in once).
 * Handles the FR-009 auto-redirect to a default collection exactly as the other specs do —
 * the assistant dock mounts on every authenticated screen, so either landing is fine, but
 * we normalise to /home so the toggle is in a known position.
 */
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
  if (!result) {
    throw new Error('gotoHome: home screen did not render — is the global-setup session valid?');
  }
}

async function openDock(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="assistant-dock-toggle"]', { state: 'visible', timeout: 60000 });
  await page.click('[data-testid="assistant-dock-toggle"]');
  await page.waitForSelector('[data-testid="assistant-dock-panel"]', { state: 'visible', timeout: 10000 });
}

test.describe('Assistant dock (feature 012)', () => {
  test('renders the dock overlay and toggles the panel open/closed (no backend)', async ({ page }) => {
    await gotoHome(page);

    const toggle = page.locator('[data-testid="assistant-dock-toggle"]');
    await expect(toggle).toBeVisible();
    // Closed by default — the panel (which binds the AG-UI agent) is not mounted.
    await expect(page.locator('[data-testid="assistant-dock-panel"]')).toHaveCount(0);

    await page.click('[data-testid="assistant-dock-toggle"]');
    await expect(page.locator('[data-testid="assistant-dock-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="assistant-dock-input"]')).toBeVisible();

    await page.click('[data-testid="assistant-dock-toggle"]');
    await expect(page.locator('[data-testid="assistant-dock-panel"]')).toHaveCount(0);
  });

  test('sends a message and renders the streamed AG-UI assistant reply', async ({ page }) => {
    await gotoHome(page);
    await openDock(page);

    const prompt = 'Organize my movie collection';
    await page.fill('[data-testid="assistant-dock-input"]', prompt);
    await page.click('[data-testid="assistant-dock-send"]');

    // The user turn renders immediately (optimistic add before the run).
    const userMsg = page.locator('[data-testid="assistant-msg-user"]').last();
    await expect(userMsg).toBeVisible();
    await expect(userMsg).toContainText(prompt);

    // The assistant turn arrives over the live AG-UI stream (Ollama routing → specialist/decline).
    const assistantMsg = page.locator('[data-testid="assistant-msg-assistant"]').last();
    await expect(assistantMsg).toBeVisible({ timeout: ASSISTANT_REPLY_TIMEOUT });
    await expect(assistantMsg).not.toBeEmpty();
  });
});
