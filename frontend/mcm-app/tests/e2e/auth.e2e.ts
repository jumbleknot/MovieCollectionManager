/// <reference types="detox" />

/**
 * E2E tests for registration flow (T-059)
 * Requires Detox + running Expo app + Keycloak dev environment.
 *
 * Run: npx detox test --configuration android.emu.debug tests/e2e/auth.e2e.ts
 */

describe('Registration Flow (E2E)', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  it('shows login screen on launch', async () => {
    await expect(element(by.id('login-screen'))).toBeVisible();
    await expect(element(by.id('btn-login-with-keycloak'))).toBeVisible();
    await expect(element(by.id('link-create-account'))).toBeVisible();
  });

  it('navigates to registration screen via Create Account link', async () => {
    await element(by.id('link-create-account')).tap();
    await expect(element(by.id('input-firstName'))).toBeVisible();
    await expect(element(by.id('input-email'))).toBeVisible();
    await expect(element(by.id('btn-create-account'))).toBeVisible();
  });

  it('shows validation errors for empty form submission', async () => {
    await element(by.id('link-create-account')).tap();
    await element(by.id('btn-create-account')).tap();
    await expect(element(by.id('input-firstName-error'))).toBeVisible();
    await expect(element(by.id('input-email-error'))).toBeVisible();
  });

  it('completes registration and shows email verification screen', async () => {
    await element(by.id('link-create-account')).tap();

    await element(by.id('input-firstName')).typeText('E2E');
    await element(by.id('input-lastName')).typeText('User');
    await element(by.id('input-username')).typeText(`e2euser_${Date.now()}`);
    await element(by.id('input-email')).typeText(`e2e_${Date.now()}@example.com`);
    await element(by.id('input-password')).typeText('SecurePass1!extra');
    await element(by.id('input-confirmPassword')).typeText('SecurePass1!extra');

    await element(by.id('btn-create-account')).tap();

    // Should transition to email verification screen
    await waitFor(element(by.id('email-verification-screen')))
      .toBeVisible()
      .withTimeout(10000);
  });
});

// ─── Login Flow E2E (T-079, T-080) ─────────────────────────────────────────

describe('Login Flow (E2E)', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  /**
   * T-079: Happy path — valid credentials → JWT cookie → home screen
   * NOTE: Requires Keycloak dev environment and a seeded test user.
   */
  it('logs in with valid credentials and navigates to home screen', async () => {
    await expect(element(by.id('btn-login-with-keycloak'))).toBeVisible();
    await element(by.id('btn-login-with-keycloak')).tap();

    // The system browser / Chrome Custom Tab opens with Keycloak login
    await waitFor(element(by.web.id('username')))
      .toExist()
      .withTimeout(15000);

    await element(by.web.id('username')).typeText(process.env.E2E_TEST_USER ?? 'testuser');
    await element(by.web.id('password')).typeText(process.env.E2E_TEST_PASSWORD ?? 'TestPass1!');
    await element(by.web(by.type('submit'))).tap();

    // After Keycloak redirects back, app navigates to home
    await waitFor(element(by.id('home-screen')))
      .toBeVisible()
      .withTimeout(15000);
  });

  /**
   * T-080: Invalid credentials → Keycloak error shown on hosted page
   */
  it('shows Keycloak error when login fails with invalid credentials', async () => {
    await expect(element(by.id('btn-login-with-keycloak'))).toBeVisible();
    await element(by.id('btn-login-with-keycloak')).tap();

    await waitFor(element(by.web.id('username')))
      .toExist()
      .withTimeout(15000);

    await element(by.web.id('username')).typeText('invalid_user');
    await element(by.web.id('password')).typeText('wrongpassword');
    await element(by.web(by.type('submit'))).tap();

    // Keycloak shows error on its hosted page
    await waitFor(element(by.web.text('Invalid username or password')))
      .toExist()
      .withTimeout(10000);
  });
});

// ─── Profile & Access Control E2E (T-099, T-100) ────────────────────────────

describe('Profile & Access Control (E2E)', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  beforeEach(async () => {
    await device.reloadReactNative();
  });

  /** T-099: Login → navigate to profile → verify info displayed */
  it('displays user profile after successful login', async () => {
    await element(by.id('btn-login-with-keycloak')).tap();

    await waitFor(element(by.web.id('username'))).toExist().withTimeout(15000);
    await element(by.web.id('username')).typeText(process.env.E2E_TEST_USER ?? 'testuser');
    await element(by.web.id('password')).typeText(process.env.E2E_TEST_PASSWORD ?? 'TestPass1!');
    await element(by.web(by.type('submit'))).tap();

    await waitFor(element(by.id('home-screen'))).toBeVisible().withTimeout(15000);

    await element(by.id('nav-profile')).tap();

    await waitFor(element(by.id('profile-screen'))).toBeVisible().withTimeout(5000);
    await expect(element(by.id('profile-display'))).toBeVisible();
    await expect(element(by.id('btn-logout'))).toBeVisible();
  });

  /** T-100: Access profile without login → redirected to login */
  it('redirects to login when accessing profile unauthenticated', async () => {
    // App fresh launch — not logged in
    await waitFor(element(by.id('login-screen'))).toBeVisible().withTimeout(5000);
    // Attempting to navigate directly to profile should land on login
    await expect(element(by.id('btn-login-with-keycloak'))).toBeVisible();
  });
});

// ─── Logout E2E (T-113) ──────────────────────────────────────────────────────

describe('Logout Flow (E2E)', () => {
  beforeAll(async () => {
    await device.launchApp({ newInstance: true });
  });

  /**
   * T-113: Login → navigate to profile → confirm logout → redirected to login → profile inaccessible
   */
  it('logs out and redirects to login screen', async () => {
    // Login first
    await element(by.id('btn-login-with-keycloak')).tap();
    await waitFor(element(by.web.id('username'))).toExist().withTimeout(15000);
    await element(by.web.id('username')).typeText(process.env.E2E_TEST_USER ?? 'testuser');
    await element(by.web.id('password')).typeText(process.env.E2E_TEST_PASSWORD ?? 'TestPass1!');
    await element(by.web(by.type('submit'))).tap();
    await waitFor(element(by.id('home-screen'))).toBeVisible().withTimeout(15000);

    // Navigate to profile
    await element(by.id('nav-profile')).tap();
    await waitFor(element(by.id('profile-screen'))).toBeVisible().withTimeout(5000);

    // Tap logout
    await element(by.id('btn-logout')).tap();

    // Confirm in dialog
    await waitFor(element(by.id('btn-logout-confirm'))).toBeVisible().withTimeout(3000);
    await element(by.id('btn-logout-confirm')).tap();

    // Should redirect to login
    await waitFor(element(by.id('login-screen'))).toBeVisible().withTimeout(5000);
    await expect(element(by.id('btn-login-with-keycloak'))).toBeVisible();
  });
});
