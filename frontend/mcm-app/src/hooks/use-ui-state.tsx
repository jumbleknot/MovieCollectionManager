/**
 * Readable UI-state provider (T057, US3 / research R15).
 *
 * Tracks the structural snapshot of the screen the user is currently on (current screen +
 * loaded collection/movie id + structural filter keys + nav depth) and pushes it to the BFF
 * `/bff-api/agent/ui-state` route, where it is sanitized (the sole sanitization point) and
 * cached per user. The next assistant turn reads it and bridges it to the gateway so
 * "add <movie> to this" resolves the on-screen collection (US3-AC1); an unresolvable "this"
 * makes the assistant clarify (US3-AC2).
 *
 * This holds NO user-entered values or PII — only structural fields. Screens report via
 * `useReportUiState` (on focus); the dock flushes the latest snapshot right before a turn
 * (`useUiStateFlush`) so there is no push/run race. All pushes are best-effort: a failure
 * (e.g. logged-out 401) is swallowed — the assistant simply falls back to clarifying.
 */
import React, { createContext, useCallback, useContext, useRef } from 'react';
import { useFocusEffect } from 'expo-router';

import { BFF_BASE_URL } from '@/config/bff-url';

export interface UiSnapshot {
  current_screen: 'home' | 'collection' | 'movie-detail' | 'profile' | string;
  collection_id?: string | null;
  movie_id?: string | null;
  active_filter_keys?: string[];
  nav_depth?: number;
}

interface UiStateContextValue {
  /** Record the current screen snapshot and push it to the BFF (best-effort). */
  report: (snapshot: UiSnapshot) => void;
  /** Push the latest recorded snapshot now and resolve when done (used before a turn). */
  flush: () => Promise<void>;
}

const noop = () => {};
const UiStateContext = createContext<UiStateContextValue>({
  report: noop,
  flush: async () => {},
});

async function pushSnapshot(snapshot: UiSnapshot): Promise<void> {
  try {
    // Plain credentialed fetch — deliberately NOT the apiClient axios instance, whose 401
    // refresh interceptor could trigger a token refresh that races the concurrent agent run's
    // own refresh (rotating refresh tokens → one invalidates the other → run 401). This push
    // is best-effort: on 401 it simply no-ops and the assistant clarifies (US3/R15).
    await fetch(`${BFF_BASE_URL}/bff-api/agent/ui-state`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot),
    });
  } catch {
    // Network error — swallow; never surface to the user.
  }
}

export function UiStateProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const current = useRef<UiSnapshot | null>(null);

  const report = useCallback((snapshot: UiSnapshot) => {
    current.current = snapshot;
    void pushSnapshot(snapshot);
  }, []);

  const flush = useCallback(async () => {
    if (current.current) await pushSnapshot(current.current);
  }, []);

  return <UiStateContext.Provider value={{ report, flush }}>{children}</UiStateContext.Provider>;
}

/**
 * Report this screen's structural snapshot whenever it gains focus. Call from a protected
 * screen (collection / movie-detail / home). The snapshot is re-pushed on every focus so the
 * cached context stays current as the user navigates.
 */
export function useReportUiState(snapshot: UiSnapshot): void {
  const { report } = useContext(UiStateContext);
  const key = JSON.stringify(snapshot);
  useFocusEffect(
    useCallback(() => {
      report(snapshot);
      // `key` captures the snapshot's value identity so re-focus with the same data is stable.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [report, key]),
  );
}

/** The flush function — push the latest snapshot before sending a turn (no push/run race). */
export function useUiStateFlush(): () => Promise<void> {
  return useContext(UiStateContext).flush;
}
