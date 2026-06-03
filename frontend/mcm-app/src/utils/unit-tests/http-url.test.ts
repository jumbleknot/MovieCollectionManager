/**
 * Unit tests for the http(s) scheme guard (009 finding #1, FR-003).
 * The client must never open a non-http(s) URL (e.g. javascript:, data:),
 * protecting against stored-XSS / arbitrary deep-link navigation from
 * attacker-controlled external-identifier URLs.
 */
import { isSafeHttpUrl } from '@/utils/http-url';

describe('isSafeHttpUrl', () => {
  it('accepts http and https (case-insensitive, trimmed)', () => {
    expect(isSafeHttpUrl('http://example.com')).toBe(true);
    expect(isSafeHttpUrl('https://www.imdb.com/title/tt1/')).toBe(true);
    expect(isSafeHttpUrl('  HTTPS://Example.com  ')).toBe(true);
  });

  it('rejects dangerous and unknown schemes', () => {
    expect(isSafeHttpUrl('javascript:alert(document.cookie)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeHttpUrl('ftp://example.com')).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl('   ')).toBe(false);
  });
});
