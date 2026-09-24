/**
 * Unit tests for the step-up authorization request (feature 076, T009 — FR-005, FR-007).
 *
 * Three properties carry the security of this flow and each is pinned here:
 *
 *   1. `max_age=0` — T001 measured that this re-prompts even when the SSO session is live and
 *      would otherwise be reused. Drop it and a stolen session completes the step-up silently.
 *   2. `scope` is `openid` ONLY. The backup-consent flow asks for `offline_access` because it is
 *      establishing a standing permission; minting a non-expiring token inside the flow whose
 *      whole purpose is to destroy one would be perverse.
 *   3. The PKCE verifier is returned to the CALLER (which parks it server-side), never placed in
 *      the URL. A verifier the browser holds is one an attacker with the code can also use.
 */

jest.mock('@/config/env', () => ({
  env: {
    keycloakPublicUrl: 'http://kc.example:8099',
    keycloakRealm: 'testrealm',
    keycloakClientId: 'movie-collection-manager',
  },
}));

import { buildStepUpRequest, STEP_UP_MAX_AGE_SECONDS } from '@/bff-server/account-step-up';

const REDIRECT = 'http://localhost:8082/bff-api/account/delete';

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('buildStepUpRequest', () => {
  it('forces a fresh authentication with prompt=login and max_age=0', async () => {
    const { authorizationUrl } = await buildStepUpRequest(REDIRECT);
    const p = paramsOf(authorizationUrl);

    expect(p.get('prompt')).toBe('login');
    expect(p.get('max_age')).toBe('0');
  });

  it('requests openid only and never offline_access', async () => {
    const { authorizationUrl } = await buildStepUpRequest(REDIRECT);

    expect(paramsOf(authorizationUrl).get('scope')).toBe('openid');
    expect(authorizationUrl).not.toContain('offline_access');
  });

  it('uses S256 PKCE and keeps the verifier out of the URL', async () => {
    const { authorizationUrl, codeVerifier } = await buildStepUpRequest(REDIRECT);
    const p = paramsOf(authorizationUrl);

    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toBeTruthy();
    expect(p.get('code_challenge')).not.toBe(codeVerifier);
    expect(authorizationUrl).not.toContain(codeVerifier);
  });

  it('sends the redirect URI it was given, so both OAuth legs can present the same value', async () => {
    const { authorizationUrl, redirectUri } = await buildStepUpRequest(REDIRECT);

    expect(redirectUri).toBe(REDIRECT);
    expect(paramsOf(authorizationUrl).get('redirect_uri')).toBe(REDIRECT);
  });

  it('issues a fresh, unguessable state and verifier on every call', async () => {
    const a = await buildStepUpRequest(REDIRECT);
    const b = await buildStepUpRequest(REDIRECT);

    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.state.length).toBeGreaterThanOrEqual(16);
    expect(a.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(paramsOf(a.authorizationUrl).get('state')).toBe(a.state);
  });

  it('targets the realm authorize endpoint on the browser-facing URL', async () => {
    const { authorizationUrl } = await buildStepUpRequest(REDIRECT);

    expect(authorizationUrl).toContain(
      'http://kc.example:8099/realms/testrealm/protocol/openid-connect/auth',
    );
  });

  it('exports the freshness window the verifier and the pending record share', () => {
    expect(STEP_UP_MAX_AGE_SECONDS).toBe(300);
  });
});
