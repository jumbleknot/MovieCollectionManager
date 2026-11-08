/**
 * Feature 089. Counts what the browser would report: zod's `new Function("")` probe. A control run
 * proves the counter can see a probe, because a counter that sees nothing would also read as zero.
 */
function probesWhileBuildingASchema(load: () => void): number {
  const RealFunction = globalThis.Function;
  let probes = 0;
  delete (globalThis as { __zod_globalConfig?: unknown }).__zod_globalConfig;
  globalThis.Function = new Proxy(RealFunction, {
    construct(target, args: string[]) {
      // Only zod's probe, `new Function("")`. Coverage instrumentation (istanbul) builds
      // `new Function("return this")` in every instrumented module, which is not a probe and is
      // not what the browser would report here (feature 087 T063).
      if (args.length === 1 && args[0] === '') probes += 1;
      return Reflect.construct(target, args);
    },
  });
  try {
    jest.isolateModules(() => {
      load();
      const { z } = require('zod') as typeof import('zod');
      z.object({ title: z.string() }).parse({ title: 'Heat' });
    });
  } finally {
    globalThis.Function = RealFunction;
    // zod keeps its settings here, so they outlive jest.isolateModules.
    delete (globalThis as { __zod_globalConfig?: unknown }).__zod_globalConfig;
  }
  return probes;
}

describe('zod-jitless', () => {
  it('control: zod probes when the setting is absent', () => {
    expect(probesWhileBuildingASchema(() => {})).toBeGreaterThan(0);
  });

  it('web: zod does not probe once the module has loaded', () => {
    expect(probesWhileBuildingASchema(() => require('@/utils/zod-jitless.web'))).toBe(0);
  });

  it('native: the module changes nothing', () => {
    expect(probesWhileBuildingASchema(() => require('@/utils/zod-jitless'))).toBeGreaterThan(0);
  });
});
