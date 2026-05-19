import { securityHeaders, SECURITY_HEADERS } from '@/bff-server/security-headers';

describe('securityHeaders', () => {
  it('adds Content-Security-Policy header', () => {
    const h = securityHeaders();
    expect(h.get('Content-Security-Policy')).toBe(SECURITY_HEADERS['Content-Security-Policy']);
  });

  it('adds X-Frame-Options: DENY', () => {
    const h = securityHeaders();
    expect(h.get('X-Frame-Options')).toBe('DENY');
  });

  it('adds X-Content-Type-Options: nosniff', () => {
    const h = securityHeaders();
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('adds Referrer-Policy: no-referrer', () => {
    const h = securityHeaders();
    expect(h.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('preserves extra headers passed in', () => {
    const h = securityHeaders({ 'Set-Cookie': 'session=abc; HttpOnly' });
    expect(h.get('Set-Cookie')).toBe('session=abc; HttpOnly');
    expect(h.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('security headers override conflicting extra headers', () => {
    const h = securityHeaders({ 'X-Frame-Options': 'SAMEORIGIN' });
    expect(h.get('X-Frame-Options')).toBe('DENY');
  });

  it('returns a Headers instance', () => {
    expect(securityHeaders()).toBeInstanceOf(Headers);
  });
});
