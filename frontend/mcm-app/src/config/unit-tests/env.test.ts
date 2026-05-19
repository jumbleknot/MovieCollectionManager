// env.ts evaluates all vars at module load time, so each test resets the
// module registry and re-requires to pick up changed process.env values.

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

function loadEnv() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('@/config/env') as typeof import('@/config/env')).env;
}

describe('env — default values', () => {
  it('uses the correct Keycloak defaults when env vars are absent', () => {
    delete process.env['KEYCLOAK_URL'];
    delete process.env['KEYCLOAK_REALM'];
    delete process.env['KEYCLOAK_CLIENT_ID'];

    const env = loadEnv();

    expect(env.keycloakUrl).toBe('http://localhost:8099');
    expect(env.keycloakRealm).toBe('jumbleknot');
    expect(env.keycloakClientId).toBe('movie-collection-manager');
  });

  it('uses the correct Redis default when REDIS_URL is absent', () => {
    delete process.env['REDIS_URL'];

    const env = loadEnv();

    expect(env.redisUrl).toBe('redis://localhost:6379');
  });

  it('uses 30-minute idle timeout default', () => {
    delete process.env['SESSION_IDLE_TIMEOUT_MS'];

    const env = loadEnv();

    expect(env.sessionIdleTimeoutMs).toBe(1_800_000);
  });

  it('uses 24-hour absolute timeout default', () => {
    delete process.env['SESSION_ABSOLUTE_TIMEOUT_MS'];

    const env = loadEnv();

    expect(env.sessionAbsoluteTimeoutMs).toBe(86_400_000);
  });

  it('uses 10 as the default max concurrent sessions', () => {
    delete process.env['MAX_CONCURRENT_SESSIONS'];

    const env = loadEnv();

    expect(env.maxConcurrentSessions).toBe(10);
  });
});

describe('env — environment variable overrides', () => {
  it('reads KEYCLOAK_URL when set', () => {
    process.env['KEYCLOAK_URL'] = 'http://custom-keycloak:9000';

    const env = loadEnv();

    expect(env.keycloakUrl).toBe('http://custom-keycloak:9000');
  });

  it('reads KEYCLOAK_REALM when set', () => {
    process.env['KEYCLOAK_REALM'] = 'my-realm';

    const env = loadEnv();

    expect(env.keycloakRealm).toBe('my-realm');
  });

  it('reads REDIS_URL when set', () => {
    process.env['REDIS_URL'] = 'redis://redis-host:6380';

    const env = loadEnv();

    expect(env.redisUrl).toBe('redis://redis-host:6380');
  });
});

describe('env — integer parsing', () => {
  it('parses SESSION_IDLE_TIMEOUT_MS as a number', () => {
    process.env['SESSION_IDLE_TIMEOUT_MS'] = '3600000';

    const env = loadEnv();

    expect(env.sessionIdleTimeoutMs).toBe(3_600_000);
    expect(typeof env.sessionIdleTimeoutMs).toBe('number');
  });

  it('parses SESSION_ABSOLUTE_TIMEOUT_MS as a number', () => {
    process.env['SESSION_ABSOLUTE_TIMEOUT_MS'] = '172800000';

    const env = loadEnv();

    expect(env.sessionAbsoluteTimeoutMs).toBe(172_800_000);
    expect(typeof env.sessionAbsoluteTimeoutMs).toBe('number');
  });

  it('parses MAX_CONCURRENT_SESSIONS as a number', () => {
    process.env['MAX_CONCURRENT_SESSIONS'] = '5';

    const env = loadEnv();

    expect(env.maxConcurrentSessions).toBe(5);
    expect(typeof env.maxConcurrentSessions).toBe('number');
  });
});

describe('env — isDevelopment flag', () => {
  it('is true when NODE_ENV is development', () => {
    process.env['NODE_ENV'] = 'development';

    const env = loadEnv();

    expect(env.isDevelopment).toBe(true);
  });

  it('is false when NODE_ENV is production', () => {
    process.env['NODE_ENV'] = 'production';

    const env = loadEnv();

    expect(env.isDevelopment).toBe(false);
  });

  it('is false when NODE_ENV is test', () => {
    process.env['NODE_ENV'] = 'test';

    const env = loadEnv();

    expect(env.isDevelopment).toBe(false);
  });
});
