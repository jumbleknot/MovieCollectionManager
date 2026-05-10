/**
 * Playwright web e2e tests for the Movie Collection Manager auth flow.
 * Requires `npx expo start --web` to be running at http://localhost:8081.
 *
 * Covers:
 *   - Login screen renders on launch
 *   - Navigation to registration screen
 *   - Client-side form validation
 *   - Full registration submission (expects success or server error)
 *   - Error banner display
 */

import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://localhost:8081';

/** Wait for the login screen to be visible (handles auth loading redirect). */
async function waitForLoginScreen(page: Page) {
  await page.goto(`${BASE}/(auth)/login`);
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 15000 });
}

/** Navigate to the register screen. */
async function gotoRegister(page: Page) {
  await waitForLoginScreen(page);
  await page.click('[data-testid="link-create-account"]');
  await page.waitForSelector('[data-testid="input-firstName"]', { timeout: 10000 });
}

/** Fill the registration form with the given values. */
async function fillRegisterForm(page: Page, opts: {
  firstName?: string;
  lastName?: string;
  username?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
} = {}) {
  const ts = Date.now() % 10000000; // 7-digit suffix
  const {
    firstName = 'Test',
    lastName = 'User',
    username = `pw${ts}`,          // max 9 chars — within 3–20 limit
    email = `pw${ts}@example.com`,
    password = 'SecurePass1!extra',
    confirmPassword = 'SecurePass1!extra',
  } = opts;

  if (firstName) await page.fill('[data-testid="input-firstName"]', firstName);
  if (lastName) await page.fill('[data-testid="input-lastName"]', lastName);
  if (username) await page.fill('[data-testid="input-username"]', username);
  if (email) await page.fill('[data-testid="input-email"]', email);
  if (password) await page.fill('[data-testid="input-password"]', password);
  if (confirmPassword) await page.fill('[data-testid="input-confirmPassword"]', confirmPassword);
}

// ─── Login screen ──────────────────────────────────────────────────────────────

test.describe('Login screen', () => {
  test('shows app title and action buttons on load', async ({ page }) => {
    await waitForLoginScreen(page);
    await expect(page.getByText('Movie Collection Manager')).toBeVisible();
    await expect(page.getByTestId('btn-login-with-keycloak')).toBeVisible();
    await expect(page.getByTestId('link-create-account')).toBeVisible();
  });

  test('login button is enabled when not loading', async ({ page }) => {
    await waitForLoginScreen(page);
    const btn = page.getByTestId('btn-login-with-keycloak');
    await expect(btn).toBeEnabled();
  });

  test('"Create Account" link navigates to registration screen', async ({ page }) => {
    await waitForLoginScreen(page);
    await page.click('[data-testid="link-create-account"]');
    await expect(page.getByTestId('input-firstName')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('btn-create-account')).toBeVisible();
  });
});

// ─── Registration form — client-side validation ────────────────────────────────

test.describe('Registration form — validation', () => {
  test('shows validation errors on empty form submission', async ({ page }) => {
    await gotoRegister(page);
    await page.click('[data-testid="btn-create-account"]');

    // All required fields should show errors (fields are touched on submit)
    await expect(page.getByTestId('input-firstName-error')).toBeVisible();
    await expect(page.getByTestId('input-email-error')).toBeVisible();
    await expect(page.getByTestId('input-username-error')).toBeVisible();
    await expect(page.getByTestId('input-password-error')).toBeVisible();
  });

  test('shows error for invalid email format', async ({ page }) => {
    await gotoRegister(page);
    await page.fill('[data-testid="input-email"]', 'not-an-email');
    await page.click('[data-testid="input-username"]'); // blur email
    await expect(page.getByTestId('input-email-error')).toBeVisible();
  });

  test('shows error for weak password', async ({ page }) => {
    await gotoRegister(page);
    await page.fill('[data-testid="input-password"]', 'weak');
    await page.click('[data-testid="input-firstName"]'); // blur password
    await expect(page.getByTestId('input-password-error')).toBeVisible();
  });

  test('shows error when passwords do not match', async ({ page }) => {
    await gotoRegister(page);
    await page.fill('[data-testid="input-password"]', 'SecurePass1!extra');
    await page.fill('[data-testid="input-confirmPassword"]', 'DifferentPass1!');
    await page.click('[data-testid="input-username"]'); // blur
    await expect(page.getByTestId('input-confirmPassword-error')).toBeVisible();
  });

  test('shows password strength indicator when password is entered', async ({ page }) => {
    await gotoRegister(page);
    await page.fill('[data-testid="input-password"]', 'SecurePass1!extra');
    // PasswordStrengthIndicator renders when password.length > 0
    await expect(page.locator('[data-testid="password-strength-indicator"]')).toBeVisible();
  });

  test('does not submit when form has errors', async ({ page }) => {
    await gotoRegister(page);
    // Leave form empty and submit — should stay on register screen
    await page.click('[data-testid="btn-create-account"]');
    // Should still be on the registration screen
    await expect(page.getByTestId('input-firstName')).toBeVisible();
  });
});

// ─── Registration form — submission ───────────────────────────────────────────

test.describe('Registration form — submission', () => {
  test('shows loading state while submitting', async ({ page }) => {
    await gotoRegister(page);
    await fillRegisterForm(page);

    // Intercept the BFF request so we can observe the loading state
    await page.route('**/bff-api/auth/register', async (route) => {
      // Delay response to capture loading state
      await new Promise((r) => setTimeout(r, 300));
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          message: 'Account created. Please check your email to verify your address.',
          userId: 'user-test-id',
        }),
      });
    });

    const submitBtn = page.getByTestId('btn-create-account');
    await submitBtn.click();

    // Button should be disabled while loading
    await expect(submitBtn).toBeDisabled();
  });

  test('navigates to email verification screen on success', async ({ page }) => {
    await gotoRegister(page);
    const ts = Date.now() % 10000000;
    const email = `pw${ts}@example.com`;
    await fillRegisterForm(page, { email });

    await page.route('**/bff-api/auth/register', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          message: 'Account created. Please check your email to verify your address.',
          userId: 'user-test-id',
        }),
      }),
    );

    await page.click('[data-testid="btn-create-account"]');
    await expect(page.getByTestId('email-verification-screen')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(email)).toBeVisible();
  });

  test('shows error banner on duplicate email', async ({ page }) => {
    await gotoRegister(page);
    await fillRegisterForm(page);

    await page.route('**/bff-api/auth/register', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'An account with that email already exists.',
          code: 'DUPLICATE_EMAIL',
        }),
      }),
    );

    await page.click('[data-testid="btn-create-account"]');
    await expect(page.getByTestId('register-form-error')).toBeVisible({ timeout: 8000 });
    await expect(page.getByText('An account with that email already exists.')).toBeVisible();
  });

  test('shows error banner on rate limit exceeded', async ({ page }) => {
    await gotoRegister(page);
    await fillRegisterForm(page);

    await page.route('**/bff-api/auth/register', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Too many requests. Please try again later.',
          code: 'RATE_LIMIT_EXCEEDED',
        }),
      }),
    );

    await page.click('[data-testid="btn-create-account"]');
    await expect(page.getByTestId('register-form-error')).toBeVisible({ timeout: 8000 });
  });
});

// ─── Email verification screen ────────────────────────────────────────────────

test.describe('Email verification screen', () => {
  /** Navigate directly to the verification screen via successful registration mock. */
  async function gotoVerificationScreen(page: Page) {
    await gotoRegister(page);
    const ts = Date.now() % 10000000;
    const email = `pw${ts}@example.com`;
    await fillRegisterForm(page, { email });

    await page.route('**/bff-api/auth/register', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, message: 'ok', userId: 'uid' }),
      }),
    );
    await page.click('[data-testid="btn-create-account"]');
    await page.waitForSelector('[data-testid="email-verification-screen"]', { timeout: 10000 });
    return email;
  }

  test('shows resend verification button', async ({ page }) => {
    await gotoVerificationScreen(page);
    await expect(page.getByTestId('btn-resend-verification')).toBeVisible();
  });

  test('shows success message after resend', async ({ page }) => {
    await gotoVerificationScreen(page);

    await page.route('**/bff-api/auth/resend-verification', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true }),
      }),
    );

    await page.click('[data-testid="btn-resend-verification"]');
    await expect(page.getByTestId('resent-success')).toBeVisible({ timeout: 8000 });
  });

  test('shows error message when resend fails', async ({ page }) => {
    await gotoVerificationScreen(page);

    await page.route('**/bff-api/auth/resend-verification', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Too many requests.', code: 'RATE_LIMIT_EXCEEDED' }),
      }),
    );

    await page.click('[data-testid="btn-resend-verification"]');
    await expect(page.getByTestId('resent-error')).toBeVisible({ timeout: 8000 });
  });
});
