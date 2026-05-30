import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// T011 (FR-006): the entire auth suite exercises authentication flows and drives auth
// state via its own /bff-api/auth/user route mocks. Opt out of the global authenticated
// session (storageState from global setup) so these tests start unauthenticated.
test.use({ storageState: { cookies: [], origins: [] } });

const BASE = 'http://localhost:8081';

async function waitForLoginScreen(page: Page) {
  await page.goto(`${BASE}/(auth)/login`);
  await page.waitForSelector('[data-testid="login-screen"]', { timeout: 15000 });
}

async function gotoRegister(page: Page) {
  await waitForLoginScreen(page);
  await page.click('[data-testid="link-create-account"]');
  await page.waitForSelector('[data-testid="input-firstName"]', { timeout: 10000 });
}

async function fillRegisterForm(page: Page, opts: {
  firstName?: string;
  lastName?: string;
  username?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
} = {}) {
  const ts = Date.now() % 10000000;
  const {
    firstName = 'Test',
    lastName = 'User',
    username = `pw${ts}`,
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
    await expect(page.getByTestId('btn-login-with-keycloak')).toBeEnabled();
  });

  test('"Create Account" link navigates to registration screen', async ({ page }) => {
    await waitForLoginScreen(page);
    await page.click('[data-testid="link-create-account"]');
    await expect(page.getByTestId('input-firstName')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('btn-create-account')).toBeVisible();
  });
});

// ─── Login screen — email verified banner ─────────────────────────────────────

test.describe('Login screen — email verification redirect', () => {
  test('shows verified success banner when ?verified=true is in the URL', async ({ page }) => {
    await page.goto(`${BASE}/(auth)/login?verified=true`);
    await page.waitForSelector('[data-testid="login-screen"]', { timeout: 15000 });
    await expect(page.getByTestId('login-verified-banner')).toBeVisible();
    await expect(page.getByText('Email verified! You can now log in.')).toBeVisible();
  });

  test('does not show verified banner when ?verified param is absent', async ({ page }) => {
    await waitForLoginScreen(page);
    await expect(page.getByTestId('login-verified-banner')).not.toBeVisible();
  });
});

// ─── Registration form — client-side validation ────────────────────────────────

test.describe('Registration form — validation', () => {
  test('shows validation errors on empty form submission', async ({ page }) => {
    await gotoRegister(page);
    await page.click('[data-testid="btn-create-account"]');
    await expect(page.getByTestId('input-firstName-error')).toBeVisible();
    await expect(page.getByTestId('input-email-error')).toBeVisible();
    await expect(page.getByTestId('input-username-error')).toBeVisible();
    await expect(page.getByTestId('input-password-error')).toBeVisible();
  });

  test('shows error for invalid email format', async ({ page }) => {
    await gotoRegister(page);
    await page.fill('[data-testid="input-email"]', 'not-an-email');
    await page.click('[data-testid="input-username"]');
    await expect(page.getByTestId('input-email-error')).toBeVisible();
  });

  test('shows error for weak password', async ({ page }) => {
    await gotoRegister(page);
    await page.fill('[data-testid="input-password"]', 'weak');
    await page.click('[data-testid="input-firstName"]');
    await expect(page.getByTestId('input-password-error')).toBeVisible();
  });

  test('shows error when passwords do not match', async ({ page }) => {
    await gotoRegister(page);
    await page.fill('[data-testid="input-password"]', 'SecurePass1!extra');
    await page.fill('[data-testid="input-confirmPassword"]', 'DifferentPass1!');
    await page.click('[data-testid="input-username"]');
    await expect(page.getByTestId('input-confirmPassword-error')).toBeVisible();
  });

  test('shows password strength indicator when password is entered', async ({ page }) => {
    await gotoRegister(page);
    await page.fill('[data-testid="input-password"]', 'SecurePass1!extra');
    await expect(page.locator('[data-testid="password-strength-indicator"]')).toBeVisible();
  });

  test('does not submit when form has errors', async ({ page }) => {
    await gotoRegister(page);
    await page.click('[data-testid="btn-create-account"]');
    await expect(page.getByTestId('input-firstName')).toBeVisible();
  });
});

// ─── Registration form — submission ───────────────────────────────────────────

test.describe('Registration form — submission', () => {
  test('shows loading state while submitting', async ({ page }) => {
    await gotoRegister(page);
    await fillRegisterForm(page);

    await page.route('**/bff-api/auth/register', async (route) => {
      await new Promise((r) => setTimeout(r, 300));
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, message: 'Account created. Please check your email to verify your address.', userId: 'user-test-id' }),
      });
    });

    const submitBtn = page.getByTestId('btn-create-account');
    await submitBtn.click();
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
        body: JSON.stringify({ success: true, message: 'Account created. Please check your email to verify your address.', userId: 'user-test-id' }),
      }),
    );

    await page.click('[data-testid="btn-create-account"]');
    await expect(page.getByTestId('email-verification-screen')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(email)).toBeVisible();
  });

  test('shows error banner on duplicate username', async ({ page }) => {
    await gotoRegister(page);
    await fillRegisterForm(page);

    await page.route('**/bff-api/auth/register', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'That username is already taken. Please choose another.', code: 'DUPLICATE_USERNAME' }),
      }),
    );

    await page.click('[data-testid="btn-create-account"]');
    await expect(page.getByTestId('register-form-error')).toBeVisible({ timeout: 8000 });
    await expect(page.getByText('That username is already taken. Please choose another.')).toBeVisible();
  });

  test('shows error banner on duplicate email', async ({ page }) => {
    await gotoRegister(page);
    await fillRegisterForm(page);

    await page.route('**/bff-api/auth/register', (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'An account with that email already exists.', code: 'DUPLICATE_EMAIL' }),
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
        body: JSON.stringify({ error: 'Too many requests. Please try again later.', code: 'RATE_LIMIT_EXCEEDED' }),
      }),
    );

    await page.click('[data-testid="btn-create-account"]');
    await expect(page.getByTestId('register-form-error')).toBeVisible({ timeout: 8000 });
  });
});

// ─── Email verification screen ────────────────────────────────────────────────

test.describe('Email verification screen', () => {
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
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }),
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

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const MOCK_USER = {
  id: 'user-123',
  username: 'testuser',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  roles: ['mc-user'],
  emailVerified: true,
  accountStatus: 'active',
  createdAt: '2024-01-01T00:00:00.000Z',
};

async function mockUserFirstUnauthThenAuth(page: Page): Promise<void> {
  await page.route('**/bff-api/auth/user', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_USER) }),
  );
  await page.route(
    '**/bff-api/auth/user',
    (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'UNAUTHORIZED', error: 'Not authenticated' }) }),
    { times: 1 },
  );
}

async function mockUserAuthenticated(page: Page): Promise<void> {
  await page.route('**/bff-api/auth/user', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_USER) }),
  );
}

async function interceptKeycloakPopup(context: BrowserContext): Promise<void> {
  await context.route('**/realms/jumbleknot/protocol/openid-connect/auth**', async (route) => {
    const url = new URL(route.request().url());
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    const callbackUrl = `${redirectUri}?code=test-auth-code&state=${encodeURIComponent(state)}`;
    await route.fulfill({ status: 302, headers: { Location: callbackUrl } });
  });
}

// ─── Keycloak login flow ───────────────────────────────────────────────────────

test.describe('Keycloak login flow', () => {
  test('successful login navigates to the home screen', async ({ page, context }) => {
    await mockUserFirstUnauthThenAuth(page);
    await interceptKeycloakPopup(context);
    await page.route('**/bff-api/auth/login', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, user: MOCK_USER }),
        headers: { 'X-Session-Id': 'sess-test-123' },
      }),
    );

    await waitForLoginScreen(page);
    await page.click('[data-testid="btn-login-with-keycloak"]');
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 20000 });
  });

  test('BFF login error shows error banner on the login screen', async ({ page, context }) => {
    await page.route('**/bff-api/auth/user', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'UNAUTHORIZED', error: 'Not authenticated' }) }),
    );
    await interceptKeycloakPopup(context);
    await page.route('**/bff-api/auth/login', (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'FORBIDDEN', error: 'You do not have permission to access this resource.' }),
      }),
    );

    await waitForLoginScreen(page);
    await page.click('[data-testid="btn-login-with-keycloak"]');
    await expect(page.getByTestId('login-error-banner')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('You do not have permission to access this resource.')).toBeVisible();
  });

  test('EMAIL_NOT_VERIFIED error shows the specific message', async ({ page, context }) => {
    await page.route('**/bff-api/auth/user', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'UNAUTHORIZED' }) }),
    );
    await interceptKeycloakPopup(context);
    await page.route('**/bff-api/auth/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'EMAIL_NOT_VERIFIED', error: 'Please verify your email address before logging in.' }),
      }),
    );

    await waitForLoginScreen(page);
    await page.click('[data-testid="btn-login-with-keycloak"]');
    await expect(page.getByTestId('login-error-banner')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Please verify your email address before logging in.')).toBeVisible();
  });
});

// ─── Auth guard ───────────────────────────────────────────────────────────────

test.describe('Auth guard', () => {
  test('redirects unauthenticated user from /home to the login screen', async ({ page }) => {
    await page.route('**/bff-api/auth/user', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'UNAUTHORIZED' }) }),
    );
    await page.goto(`${BASE}/(app)/home`);
    await expect(page.getByTestId('login-screen')).toBeVisible({ timeout: 15000 });
  });

  test('allows authenticated user to access /home', async ({ page }) => {
    await mockUserAuthenticated(page);
    await page.goto(`${BASE}/(app)/home`);
    await expect(page.getByTestId('home-route')).toBeVisible({ timeout: 15000 });
  });
});

// ─── Profile screen (authenticated) ───────────────────────────────────────────

test.describe('Profile screen (authenticated)', () => {
  test('shows navigation bar and profile display', async ({ page }) => {
    await mockUserAuthenticated(page);
    await page.goto(`${BASE}/(app)/profile`);
    await expect(page.getByTestId('profile-screen')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('navigation-bar')).toBeVisible();
    await expect(page.getByTestId('profile-display')).toBeVisible();
    await expect(page.getByTestId('btn-logout')).toBeVisible();
  });

  test('displays correct user details in profile', async ({ page }) => {
    await mockUserAuthenticated(page);
    await page.goto(`${BASE}/(app)/profile`);
    await expect(page.getByTestId('profile-screen')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('testuser')).toBeVisible();
    await expect(page.getByText('test@example.com')).toBeVisible();
  });

  // US3 Scenario 2 / FR-009: all six required profile fields rendered
  test('profile display shows all required fields (username, email, first name, last name, roles, status)', async ({ page }) => {
    await mockUserAuthenticated(page);
    await page.goto(`${BASE}/(app)/profile`);
    await expect(page.getByTestId('profile-screen')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('profile-username')).toBeVisible();
    await expect(page.getByTestId('profile-email')).toBeVisible();
    await expect(page.getByTestId('profile-first-name')).toBeVisible();
    await expect(page.getByTestId('profile-last-name')).toBeVisible();
    await expect(page.getByTestId('profile-roles')).toBeVisible();
    await expect(page.getByTestId('profile-status')).toBeVisible();
    // Verify actual values from MOCK_USER (scoped to avoid strict-mode collisions)
    await expect(page.getByTestId('profile-first-name').getByText('Test')).toBeVisible();
    await expect(page.getByTestId('profile-last-name').getByText('User')).toBeVisible();
    await expect(page.getByTestId('profile-roles').getByText('mc-user')).toBeVisible();
    await expect(page.getByTestId('profile-status').getByText('Active')).toBeVisible();
  });

  test('logout button opens confirmation dialog', async ({ page }) => {
    await mockUserAuthenticated(page);
    await page.goto(`${BASE}/(app)/profile`);
    await expect(page.getByTestId('profile-screen')).toBeVisible({ timeout: 15000 });
    await page.click('[data-testid="btn-logout"]');
    await expect(page.getByTestId('logout-dialog')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Are you sure you want to logout?')).toBeVisible();
  });

  test('cancelling logout dialog keeps user on the profile screen', async ({ page }) => {
    await mockUserAuthenticated(page);
    await page.goto(`${BASE}/(app)/profile`);
    await expect(page.getByTestId('profile-screen')).toBeVisible({ timeout: 15000 });
    await page.click('[data-testid="btn-logout"]');
    await expect(page.getByTestId('logout-dialog')).toBeVisible({ timeout: 5000 });
    await page.click('[data-testid="btn-logout-cancel"]');
    await expect(page.getByTestId('logout-dialog')).not.toBeVisible();
    await expect(page.getByTestId('profile-screen')).toBeVisible();
  });

  test('confirming logout ends the session and returns to the login screen', async ({ page }) => {
    await mockUserAuthenticated(page);
    await page.route('**/bff-api/auth/logout', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, message: 'Logged out successfully.' }) }),
    );
    await page.goto(`${BASE}/(app)/profile`);
    await expect(page.getByTestId('profile-screen')).toBeVisible({ timeout: 15000 });
    await page.click('[data-testid="btn-logout"]');
    await expect(page.getByTestId('logout-dialog')).toBeVisible({ timeout: 5000 });
    await page.click('[data-testid="btn-logout-confirm"]');
    await expect(page.getByTestId('login-screen')).toBeVisible({ timeout: 10000 });
  });
});
