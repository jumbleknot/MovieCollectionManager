/**
 * Which overlay is open (098, FR-015, data-model OpenPanel).
 *
 * Two overlays share the authenticated app: the assistant dock (in the (app) layout) and the
 * collection screen's view options. At most one is open at a time — opening one closes the other —
 * so they never stack over each other. The provider is mounted in `src/app/(app)/_layout.tsx`
 * around both the Stack and the assistant dock.
 *
 * ENTRY-CHUNK RULE (feature 077): this module is loaded on every authenticated route. It must
 * import nothing from `@copilotkit/*`, `@ag-ui/*` or `@/hooks/use-assistant`; a unit test asserts it.
 */
import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

export type PanelName = 'assistant' | 'view-options';

export interface OpenPanelValue {
  openPanel: PanelName | null;
  open: (name: PanelName) => void;
  /** Closes `name` only if it is the open one; closing another panel is a no-op. */
  close: (name: PanelName) => void;
  toggle: (name: PanelName) => void;
}

const OpenPanelContext = createContext<OpenPanelValue | null>(null);

export function OpenPanelProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [openPanel, setOpenPanel] = useState<PanelName | null>(null);

  const open = useCallback((name: PanelName) => setOpenPanel(name), []);
  const close = useCallback(
    (name: PanelName) => setOpenPanel((cur) => (cur === name ? null : cur)),
    [],
  );
  const toggle = useCallback(
    (name: PanelName) => setOpenPanel((cur) => (cur === name ? null : name)),
    [],
  );

  const value = useMemo(
    () => ({ openPanel, open, close, toggle }),
    [openPanel, open, close, toggle],
  );
  return <OpenPanelContext.Provider value={value}>{children}</OpenPanelContext.Provider>;
}

export function useOpenPanel(): OpenPanelValue {
  const ctx = useContext(OpenPanelContext);
  if (!ctx) {
    throw new Error(
      'useOpenPanel must be used inside <OpenPanelProvider> (src/app/(app)/_layout.tsx).',
    );
  }
  return ctx;
}
