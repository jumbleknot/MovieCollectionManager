/**
 * Warm the assistant runtime chunk once the route is interactive (feature 077; FR-004).
 *
 * THE POINT IS THE TIMING, not the fetch. Deferring the assistant's ~2.4 MB is what makes `/home`
 * paint quickly; fetching it on idle afterwards is what stops the user paying for that deferral when
 * they do press the toggle. Get the order wrong — start the fetch during render — and the chunk
 * competes with the route's own bytes on a serialized connection, making the page SLOWER than before
 * the split while every byte-total still looks improved. `requestIdleCallback` is the whole
 * mechanism: it fires when the browser has nothing better to do, which by definition is after the
 * screen is usable.
 *
 * `setTimeout(0)` is the fallback where `requestIdleCallback` is missing (native, older Safari). It
 * is weaker — a macrotask, not a true idle slot — but it still yields to the current render and
 * paint, and native has no separate chunk to fetch anyway, so nothing is riding on it there.
 *
 * A prefetch failure is deliberately swallowed: the user has asked for nothing yet, so a speculative
 * fetch that fails must not reach them. The failure that DOES matter is the one behind the toggle,
 * and `loadAssistantRuntime` clears its cache on rejection so that path retries.
 */
import { useEffect } from 'react';

import { loadAssistantRuntime } from '@/utils/assistant-runtime-loader';

type IdleWindow = {
  requestIdleCallback?: (cb: () => void) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function useAssistantRuntimePrefetch(): void {
  useEffect(() => {
    const g = globalThis as unknown as IdleWindow;
    const warm = () => {
      // Speculative: swallow, never surface. See the header.
      void loadAssistantRuntime().catch(() => {});
    };

    if (typeof g.requestIdleCallback === 'function') {
      const handle = g.requestIdleCallback(warm);
      return () => {
        g.cancelIdleCallback?.(handle);
      };
    }

    const timer = setTimeout(warm, 0);
    return () => clearTimeout(timer);
  }, []);
}
