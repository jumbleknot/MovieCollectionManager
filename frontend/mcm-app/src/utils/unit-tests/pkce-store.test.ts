import { storePkce, consumePkce } from '@/utils/pkce-store';

// Reset module state before each test by consuming any leftover values.
beforeEach(() => {
  consumePkce();
});

describe('pkce-store — initial state', () => {
  it('consumePkce returns null for both fields before anything is stored', () => {
    const result = consumePkce();

    expect(result.codeVerifier).toBeNull();
    expect(result.redirectUri).toBeNull();
  });
});

describe('pkce-store — storePkce / consumePkce round-trip', () => {
  it('consumePkce returns the codeVerifier and redirectUri that were stored', () => {
    storePkce('verifier-abc', 'http://localhost:8081/auth-callback');

    const result = consumePkce();

    expect(result.codeVerifier).toBe('verifier-abc');
    expect(result.redirectUri).toBe('http://localhost:8081/auth-callback');
  });

  it('consumePkce clears state so a second call returns null/null', () => {
    storePkce('verifier-abc', 'http://localhost:8081/auth-callback');
    consumePkce();

    const result = consumePkce();

    expect(result.codeVerifier).toBeNull();
    expect(result.redirectUri).toBeNull();
  });

  it('a second storePkce overwrites the first before it is consumed', () => {
    storePkce('verifier-first', 'http://first/callback');
    storePkce('verifier-second', 'http://second/callback');

    const result = consumePkce();

    expect(result.codeVerifier).toBe('verifier-second');
    expect(result.redirectUri).toBe('http://second/callback');
  });

  it('storePkce after a consume stores fresh values correctly', () => {
    storePkce('verifier-one', 'http://one/callback');
    consumePkce();

    storePkce('verifier-two', 'http://two/callback');
    const result = consumePkce();

    expect(result.codeVerifier).toBe('verifier-two');
    expect(result.redirectUri).toBe('http://two/callback');
  });
});
