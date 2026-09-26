// The assistant runtime's dynamic import — single-flight, and retryable (feature 077, T006).
//
// FR-004 (at most one fetch per page session) and FR-006 (a failed load stays recoverable). The
// retry case is the one a plausible implementation gets wrong: `inFlight ??= import(...)` is
// single-flight but CACHES THE REJECTION, so one failed fetch disables the assistant for the rest
// of the page's life. The user's only recovery would be a reload, for a chunk that would probably
// have arrived on a second try.
import {
  loadAssistantRuntime,
  resetAssistantRuntimeForTest,
} from '@/utils/assistant-runtime-loader';

type Mod = { default: () => null };
const mod: Mod = { default: () => null };

beforeEach(() => {
  resetAssistantRuntimeForTest();
});

describe('single-flight', () => {
  it('imports once for two sequential calls, and resolves both to the same module', async () => {
    let calls = 0;
    const importer = async () => {
      calls += 1;
      return mod;
    };

    const first = await loadAssistantRuntime(importer);
    const second = await loadAssistantRuntime(importer);

    expect(calls).toBe(1);
    expect(first).toBe(mod);
    expect(second).toBe(mod);
  });

  it('imports once for calls that race before the first settles', async () => {
    // The real case: the idle prefetch and a user's press land in the same tick.
    let calls = 0;
    let release: (m: Mod) => void = () => {};
    const importer = () => {
      calls += 1;
      return new Promise<Mod>((resolve) => {
        release = resolve;
      });
    };

    const a = loadAssistantRuntime(importer);
    const b = loadAssistantRuntime(importer);
    release(mod);

    expect(await a).toBe(mod);
    expect(await b).toBe(mod);
    expect(calls).toBe(1);
  });
});

describe('failure is recoverable (FR-006)', () => {
  it('retries after a rejection instead of replaying it', async () => {
    let calls = 0;
    const importer = async () => {
      calls += 1;
      if (calls === 1) throw new Error('chunk load failed');
      return mod;
    };

    await expect(loadAssistantRuntime(importer)).rejects.toThrow('chunk load failed');
    // A `??=` cache would hand back the SAME rejected promise here and never call the importer
    // again — the assistant would stay broken until a page reload.
    await expect(loadAssistantRuntime(importer)).resolves.toBe(mod);
    expect(calls).toBe(2);
  });

  it('does not leave a rejected promise behind for concurrent callers to inherit', async () => {
    let calls = 0;
    const importer = async () => {
      calls += 1;
      throw new Error('nope');
    };

    const a = loadAssistantRuntime(importer);
    const b = loadAssistantRuntime(importer);
    await expect(a).rejects.toThrow('nope');
    await expect(b).rejects.toThrow('nope');
    // Both shared the one in-flight attempt...
    expect(calls).toBe(1);
    // ...and the failure did not stick.
    const ok = async () => mod;
    await expect(loadAssistantRuntime(ok)).resolves.toBe(mod);
  });

  it('caches a success, so a later call does not refetch', async () => {
    let calls = 0;
    const importer = async () => {
      calls += 1;
      return mod;
    };
    await loadAssistantRuntime(importer);
    await loadAssistantRuntime(importer);
    await loadAssistantRuntime(importer);
    expect(calls).toBe(1);
  });
});

describe('the test seam', () => {
  it('resetAssistantRuntimeForTest clears the cached module', async () => {
    let calls = 0;
    const importer = async () => {
      calls += 1;
      return mod;
    };
    await loadAssistantRuntime(importer);
    resetAssistantRuntimeForTest();
    await loadAssistantRuntime(importer);
    expect(calls).toBe(2);
  });
});
