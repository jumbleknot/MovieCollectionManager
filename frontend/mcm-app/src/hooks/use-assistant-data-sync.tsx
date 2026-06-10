/**
 * Assistant data-sync (feature 012, T072) — refresh on-screen lists after an assistant WRITE.
 *
 * The conversational assistant applies collection/movie writes (add / organize) on the
 * approved-resume path. When it does, any list already on screen (the collection's movie list,
 * the movie-detail screen, the home collections) is stale until the user manually re-navigates —
 * `useFocusEffect` does not re-fire while the screen stays focused under the dock overlay.
 *
 * This module bridges the gap with a tiny monotonically-increasing "data revision": the dock
 * bumps it exactly once when a run that included an APPROVED write finishes (see
 * `assistant-dock`), and any screen list re-fetches when the revision changes. Reads/queries
 * (no approval) never bump it, so a read turn triggers no refetch.
 *
 * Additive (SC-005): the revision starts at 0 and only ever moves on an assistant write, so app
 * flows that don't use the assistant are unaffected; `useAssistantDataRefresh` skips the initial
 * mount so a screen's own first load is never doubled.
 */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

type AssistantDataSync = { revision: number; bumpRevision: () => void };

const AssistantDataSyncContext = createContext<AssistantDataSync>({
  revision: 0,
  bumpRevision: () => {},
});

export function AssistantDataSyncProvider({ children }: { children: React.ReactNode }) {
  const [revision, setRevision] = useState(0);
  const bumpRevision = useCallback(() => setRevision((r) => r + 1), []);
  return (
    <AssistantDataSyncContext.Provider value={{ revision, bumpRevision }}>
      {children}
    </AssistantDataSyncContext.Provider>
  );
}

/** Returns the bump fn the dock calls when an approved assistant write completes. */
export function useBumpAssistantData(): () => void {
  return useContext(AssistantDataSyncContext).bumpRevision;
}

/**
 * Re-run `refetch` whenever an assistant write completes (the revision changes). The initial
 * mount is skipped — the screen does its own first load — so this only ever ADDS a post-write
 * refresh, never doubles the first fetch. `refetch` is read through a ref so a non-memoized
 * callback doesn't re-trigger the effect on every render.
 */
export function useAssistantDataRefresh(refetch: () => void): void {
  const { revision } = useContext(AssistantDataSyncContext);
  const refetchRef = useRef(refetch);
  const seenRef = useRef(revision);

  // Keep the ref pointing at the latest closure — updated in an effect (never mutated during
  // render). Declared BEFORE the revision effect so on a revision change it runs first.
  useEffect(() => {
    refetchRef.current = refetch;
  });

  useEffect(() => {
    if (revision === seenRef.current) return; // initial mount (or no change) — skip
    seenRef.current = revision;
    refetchRef.current();
  }, [revision]);
}
