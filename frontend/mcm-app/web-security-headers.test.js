'use strict';

/**
 * Unit test (RED→GREEN) for the web security-header builder (feature 032, US1).
 *
 * Governs: FR-001..FR-004, FR-006, FR-007, FR-010. The oracle is
 * specs/032-security-header-hardening/contracts/security-headers-contract.md (Surface 1 + 2)
 * — the pure builder must produce the exact web-app CSP + the four static header values,
 * mark `/bff-api` paths CSP-exempt, and never emit a broken directive on a malformed origin.
 */

const {
  buildWebSecurityHeaders,
  isApiPath,
} = require('./web-security-headers');

const DEFAULT_ORIGIN = 'http://localhost:8099';

describe('buildWebSecurityHeaders', () => {
  it('returns the four static baseline headers (contract Surface 1)', () => {
    const h = buildWebSecurityHeaders({ keycloakOrigin: DEFAULT_ORIGIN });
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('no-referrer');
  });

  it('builds the web-app CSP with the required directives and the Keycloak origin in connect-src', () => {
    const csp = buildWebSecurityHeaders({ keycloakOrigin: DEFAULT_ORIGIN })['Content-Security-Policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain(`connect-src 'self' ${DEFAULT_ORIGIN}`);
    // script-src allow-lists Expo's inline hydration script by its stable sha256 hash (T006),
    // NOT 'unsafe-inline'/'unsafe-eval' — strict anti-XSS posture.
    expect(csp).toContain("script-src 'self' 'sha256-67fhrP0+BkBqmgGGXTtgiVO/9EQs3QruYNU/7fnRkI8='");
    // scripts must not permit eval anywhere in the policy (style-src's 'unsafe-inline' is fine).
    expect(csp).not.toContain("'unsafe-eval'");
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src '));
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it('reduces a full Keycloak URL to its origin (scheme://host[:port], no path)', () => {
    const csp = buildWebSecurityHeaders({
      keycloakOrigin: 'https://auth.example.com/realms/mcm/.well-known/openid-configuration',
    })['Content-Security-Policy'];
    expect(csp).toContain("connect-src 'self' https://auth.example.com");
    expect(csp).not.toContain('/realms/');
  });

  it('falls back to the localhost default when the origin is malformed (never a broken directive)', () => {
    const csp = buildWebSecurityHeaders({ keycloakOrigin: 'not a url' })['Content-Security-Policy'];
    expect(csp).toContain(`connect-src 'self' ${DEFAULT_ORIGIN}`);
  });

  it('falls back to the localhost default when the origin is missing', () => {
    const csp = buildWebSecurityHeaders({})['Content-Security-Policy'];
    expect(csp).toContain(`connect-src 'self' ${DEFAULT_ORIGIN}`);
  });
});

describe('isApiPath', () => {
  it('marks /bff-api paths as CSP-exempt (API keeps its strict handler CSP)', () => {
    expect(isApiPath('/bff-api/auth/init')).toBe(true);
    expect(isApiPath('/bff-api')).toBe(true);
  });

  it('does not mark web/static paths as API paths', () => {
    expect(isApiPath('/')).toBe(false);
    expect(isApiPath('/home')).toBe(false);
    expect(isApiPath('/_expo/static/js/app.js')).toBe(false);
    expect(isApiPath('/favicon.ico')).toBe(false);
  });
});
