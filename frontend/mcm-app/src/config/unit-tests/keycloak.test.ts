// Module-level constants (KEYCLOAK_URL, KEYCLOAK_ISSUER, etc.) are evaluated
// at load time — each describe block resets the module registry and re-requires.
// keycloakConfig.redirectUri is a lazy getter so it is tested via the exported config.

const ORIGINAL_ENV = process.env;
const ORIGINAL_WINDOW = global.window;

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
  // Restore window to whatever the previous test may have changed
  Object.defineProperty(global, 'window', { value: ORIGINAL_WINDOW, writable: true, configurable: true });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
  Object.defineProperty(global, 'window', { value: ORIGINAL_WINDOW, writable: true, configurable: true });
});

function loadKeycloak() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/config/keycloak') as typeof import('@/config/keycloak');
}

// ─── KEYCLOAK_URL ─────────────────────────────────────────────────────────────

describe('KEYCLOAK_URL — web platform', () => {
  beforeEach(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));
    delete process.env['KEYCLOAK_URL'];
    delete process.env['EXPO_PUBLIC_KEYCLOAK_URL'];
    delete process.env['EXPO_PUBLIC_KEYCLOAK_NATIVE_URL'];
  });

  it('defaults to localhost:8099 on web', () => {
    const { KEYCLOAK_URL } = loadKeycloak();
    expect(KEYCLOAK_URL).toBe('http://localhost:8099');
  });

  it('reads KEYCLOAK_URL env var on web', () => {
    process.env['KEYCLOAK_URL'] = 'http://keycloak-prod:8080';
    const { KEYCLOAK_URL } = loadKeycloak();
    expect(KEYCLOAK_URL).toBe('http://keycloak-prod:8080');
  });

  // A plain (non-EXPO_PUBLIC) var cannot be inlined into the browser bundle by Metro, so the deployed
  // web app never sees KEYCLOAK_URL and silently used localhost:8099 in prod. The browser-facing
  // authorize host must come from an EXPO_PUBLIC_* var baked at web-export time.
  it('prefers EXPO_PUBLIC_KEYCLOAK_URL on web (browser-inlinable, for prod)', () => {
    process.env['EXPO_PUBLIC_KEYCLOAK_URL'] = 'https://auth.example.com';
    const { KEYCLOAK_URL } = loadKeycloak();
    expect(KEYCLOAK_URL).toBe('https://auth.example.com');
  });

  it('EXPO_PUBLIC_KEYCLOAK_URL takes precedence over KEYCLOAK_URL on web', () => {
    process.env['EXPO_PUBLIC_KEYCLOAK_URL'] = 'https://auth.example.com';
    process.env['KEYCLOAK_URL'] = 'http://keycloak-service:8080';
    const { KEYCLOAK_URL } = loadKeycloak();
    expect(KEYCLOAK_URL).toBe('https://auth.example.com');
  });
});

describe('KEYCLOAK_URL — native platform', () => {
  beforeEach(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
    delete process.env['EXPO_PUBLIC_KEYCLOAK_NATIVE_URL'];
  });

  it('defaults to the Android emulator address on native', () => {
    const { KEYCLOAK_URL } = loadKeycloak();
    expect(KEYCLOAK_URL).toBe('http://10.0.2.2:8099');
  });

  it('reads EXPO_PUBLIC_KEYCLOAK_NATIVE_URL on native', () => {
    process.env['EXPO_PUBLIC_KEYCLOAK_NATIVE_URL'] = 'http://192.168.1.100:8099';
    const { KEYCLOAK_URL } = loadKeycloak();
    expect(KEYCLOAK_URL).toBe('http://192.168.1.100:8099');
  });
});

// ─── KEYCLOAK_ISSUER & KEYCLOAK_DISCOVERY_ENDPOINT ───────────────────────────

describe('derived constants', () => {
  beforeEach(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));
    process.env['KEYCLOAK_URL'] = 'http://kc:8099';
    process.env['KEYCLOAK_REALM'] = 'test-realm';
  });

  it('KEYCLOAK_ISSUER is composed from URL and realm', () => {
    const { KEYCLOAK_ISSUER } = loadKeycloak();
    expect(KEYCLOAK_ISSUER).toBe('http://kc:8099/realms/test-realm');
  });

  it('KEYCLOAK_DISCOVERY_ENDPOINT appends the OIDC well-known path', () => {
    const { KEYCLOAK_DISCOVERY_ENDPOINT } = loadKeycloak();
    expect(KEYCLOAK_DISCOVERY_ENDPOINT).toBe(
      'http://kc:8099/realms/test-realm/.well-known/openid-configuration',
    );
  });
});

// ─── redirectUri getter ───────────────────────────────────────────────────────

describe('keycloakConfig.redirectUri — native platform', () => {
  beforeEach(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
  });

  it('returns the custom mcm-app:// scheme URI', () => {
    const { keycloakConfig } = loadKeycloak();
    expect(keycloakConfig.redirectUri).toBe('mcm-app://native-auth-callback');
  });
});

describe('keycloakConfig.redirectUri — web platform with window', () => {
  beforeEach(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));
    Object.defineProperty(global, 'window', {
      value: { location: { origin: 'https://app.example.com' } },
      writable: true,
      configurable: true,
    });
  });

  it('uses window.location.origin at runtime', () => {
    const { keycloakConfig } = loadKeycloak();
    expect(keycloakConfig.redirectUri).toBe('https://app.example.com/auth-callback');
  });
});

describe('keycloakConfig.redirectUri — web platform without window (SSR)', () => {
  beforeEach(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));
    Object.defineProperty(global, 'window', { value: undefined, writable: true, configurable: true });
    delete process.env['EXPO_PUBLIC_BFF_BASE_URL'];
  });

  it('falls back to EXPO_PUBLIC_BFF_BASE_URL during SSR', () => {
    process.env['EXPO_PUBLIC_BFF_BASE_URL'] = 'http://ssr-host:8081';
    const { keycloakConfig } = loadKeycloak();
    expect(keycloakConfig.redirectUri).toBe('http://ssr-host:8081/auth-callback');
  });

  it('falls back to localhost default when no env var is set during SSR', () => {
    const { keycloakConfig } = loadKeycloak();
    expect(keycloakConfig.redirectUri).toBe('http://localhost:8081/auth-callback');
  });
});
