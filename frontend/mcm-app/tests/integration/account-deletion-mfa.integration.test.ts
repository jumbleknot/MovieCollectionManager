/**
 * The second-factor branch of the step-up (feature 076, T030/T031 — FR-007, FR-008; SC-013).
 *
 * FR-007 requires an authentication meeting the identity provider's configured requirement for a
 * high-privilege action. FR-008 forbids refusing a user who has no second factor — otherwise a
 * user who never enrolled one could not leave, which is the problem this feature exists to fix.
 *
 * Both halves are observed against the live realm rather than inferred from configuration,
 * because the default fixture user has no TOTP credential and therefore never exercises the
 * conditional branch at all. Without an enrolled user this requirement is simply untested, and a
 * green suite would say nothing about it.
 *
 * The mechanism is the realm's stock browser flow: `Browser - Conditional 2FA` gated on
 * `conditional-user-configured`. The application never decides the policy — which is what FR-008
 * requires and what the constitution prohibits it from doing.
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  createTestUser,
  deleteTestUser,
  type TestUser,
} from './helpers/keycloak-test-client';
import { enrolTotp, walkStepUpLogin, totpCode } from './helpers/keycloak-browser-flow';

const REDIRECT_URI = 'http://localhost:8082/bff-api/account/delete';

const CREDS_PRESENT = Boolean(process.env.KEYCLOAK_SERVICE_CLIENT_SECRET);
if (!CREDS_PRESENT && process.env.MCM_REQUIRE_LIVE_STACK === '1') {
  throw new Error('account-deletion-mfa requires KEYCLOAK_SERVICE_CLIENT_SECRET');
}
const describeLive = CREDS_PRESENT ? describe : describe.skip;

jest.setTimeout(60_000);

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(40).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

describeLive('step-up second factor', () => {
  let user: TestUser;

  beforeEach(async () => {
    user = await createTestUser('t030-mfa');
  });

  afterEach(async () => {
    if (user?.userId) await deleteTestUser(user.userId);
  });

  it('does NOT demand a second factor from a user who has none (FR-008)', async () => {
    const { challenge } = pkce();

    const result = await walkStepUpLogin({
      username: user.username,
      password: user.password,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
    });

    // A user who never enrolled one must still be able to leave. Refusing here would strand
    // them with an account they cannot delete.
    expect(result.promptedForOtp).toBe(false);
    expect(result.code).toBeTruthy();
  });

  it('DEMANDS a second factor from a user who has one enrolled (FR-007)', async () => {
    await enrolTotp(user.userId);
    const { challenge } = pkce();

    const result = await walkStepUpLogin({
      username: user.username,
      password: user.password,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      // Deliberately omitted: stop at the OTP page to prove it was reached.
    });

    // The password alone did not complete the step-up. If this were false, a stolen password
    // would satisfy a deletion for a user who had specifically armed themselves against that.
    expect(result.promptedForOtp).toBe(true);
    expect(result.code).toBeUndefined();
  });

  it('completes once the correct second factor is supplied (SC-013)', async () => {
    const secret = await enrolTotp(user.userId);
    const { challenge } = pkce();

    const result = await walkStepUpLogin({
      username: user.username,
      password: user.password,
      redirectUri: REDIRECT_URI,
      codeChallenge: challenge,
      totpSecret: secret,
    });

    expect(result.promptedForOtp).toBe(true);
    expect(result.code).toBeTruthy();
  });

  it('generates a six-digit code that changes with the time step', () => {
    const secret = 'JBSWY3DPEHPK3PXP';

    // A regression guard on the TOTP implementation itself: if this were constant, the test
    // above would pass against a broken generator and prove nothing about the second factor.
    expect(totpCode(secret, 0)).toMatch(/^\d{6}$/);
    expect(totpCode(secret, 0)).not.toBe(totpCode(secret, 3600));
  });
});
