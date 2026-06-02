/**
 * Characterization tests for the default-collection auto-navigation flag.
 *
 * Traceability: FR-009 (auto-navigate to default collection once per session).
 *
 * These tests lock the EXISTING behavior of `isAutoNavDone` / `markAutoNavDone`
 * / `clearAutoNav` so the rename from `utils/fr009.ts` is provably
 * behavior-preserving. They are characterization tests of already-shipped
 * behavior — not RED-first new-feature TDD. `jest.resetModules()` runs before
 * each load so the module-level `_sessionFired` flag starts fresh per case.
 */

describe('default-collection-auto-nav', () => {
  afterEach(() => {
    jest.resetModules();
    jest.unmock('react-native');
  });

  describe('native (module-level flag)', () => {
    function loadNative() {
      jest.resetModules();
      jest.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('../default-collection-auto-nav');
    }

    it('isAutoNavDone is false initially', () => {
      const { isAutoNavDone } = loadNative();
      expect(isAutoNavDone()).toBe(false);
    });

    it('isAutoNavDone is true after markAutoNavDone', () => {
      const { isAutoNavDone, markAutoNavDone } = loadNative();
      markAutoNavDone();
      expect(isAutoNavDone()).toBe(true);
    });

    it('isAutoNavDone is false again after clearAutoNav', () => {
      const { isAutoNavDone, markAutoNavDone, clearAutoNav } = loadNative();
      markAutoNavDone();
      clearAutoNav();
      expect(isAutoNavDone()).toBe(false);
    });
  });

  describe('web (sessionStorage-backed)', () => {
    let store: Record<string, string>;

    beforeEach(() => {
      store = {};
      Object.defineProperty(globalThis, 'sessionStorage', {
        configurable: true,
        writable: true,
        value: {
          getItem: (k: string) => (k in store ? store[k] : null),
          setItem: (k: string, v: string) => {
            store[k] = v;
          },
          removeItem: (k: string) => {
            delete store[k];
          },
        },
      });
    });

    afterEach(() => {
      delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    });

    function loadWeb() {
      jest.resetModules();
      jest.doMock('react-native', () => ({ Platform: { OS: 'web' } }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('../default-collection-auto-nav');
    }

    it('markAutoNavDone writes the mcm_auto_nav_done sessionStorage key', () => {
      const { markAutoNavDone } = loadWeb();
      markAutoNavDone();
      expect(store.mcm_auto_nav_done).toBe('1');
    });

    it('isAutoNavDone reads the key when the module-level flag is unset', () => {
      store.mcm_auto_nav_done = '1';
      const { isAutoNavDone } = loadWeb();
      expect(isAutoNavDone()).toBe(true);
    });

    it('clearAutoNav removes the sessionStorage key', () => {
      store.mcm_auto_nav_done = '1';
      const { clearAutoNav } = loadWeb();
      clearAutoNav();
      expect(store.mcm_auto_nav_done).toBeUndefined();
    });
  });
});
