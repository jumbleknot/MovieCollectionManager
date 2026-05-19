// BFF_BASE_URL is a module-level constant evaluated at load time.
// Each test resets the module registry and mocks Platform.OS before re-requiring.

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

function loadBffUrl() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('@/config/bff-url') as typeof import('@/config/bff-url')).BFF_BASE_URL;
}

describe('BFF_BASE_URL — web platform', () => {
  beforeEach(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));
  });

  it('returns an empty string for same-origin requests', () => {
    expect(loadBffUrl()).toBe('');
  });
});

describe('BFF_BASE_URL — native platform', () => {
  beforeEach(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: 'android' } }));
    delete process.env['EXPO_PUBLIC_BFF_NATIVE_URL'];
    delete process.env['EXPO_PUBLIC_BFF_BASE_URL'];
  });

  it('uses EXPO_PUBLIC_BFF_NATIVE_URL when set', () => {
    process.env['EXPO_PUBLIC_BFF_NATIVE_URL'] = 'http://192.168.1.100:8081';

    expect(loadBffUrl()).toBe('http://192.168.1.100:8081');
  });

  it('falls back to EXPO_PUBLIC_BFF_BASE_URL when NATIVE_URL is not set', () => {
    process.env['EXPO_PUBLIC_BFF_BASE_URL'] = 'http://10.0.2.2:8081';

    expect(loadBffUrl()).toBe('http://10.0.2.2:8081');
  });

  it('prefers EXPO_PUBLIC_BFF_NATIVE_URL over EXPO_PUBLIC_BFF_BASE_URL', () => {
    process.env['EXPO_PUBLIC_BFF_NATIVE_URL'] = 'http://native-url:8081';
    process.env['EXPO_PUBLIC_BFF_BASE_URL'] = 'http://base-url:8081';

    expect(loadBffUrl()).toBe('http://native-url:8081');
  });

  it('falls back to the Android emulator default when no env vars are set', () => {
    expect(loadBffUrl()).toBe('http://10.0.2.2:8081');
  });
});
