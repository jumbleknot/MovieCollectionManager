/**
 * OpenPanel context (098 T005, data-model OpenPanel, FR-015).
 *
 * At most one of the two overlays — the assistant dock and the collection view options — is open at
 * a time: opening one closes the other. The provider lives in the (app) layout, which is in the web
 * ENTRY chunk, so it must import nothing from the assistant runtime (feature 077 bundle-budget).
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderHook, act } from '@testing-library/react-native';

import { OpenPanelProvider, useOpenPanel } from '@/hooks/use-open-panel';

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <OpenPanelProvider>{children}</OpenPanelProvider>;
}

describe('useOpenPanel', () => {
  it('starts with no panel open', async () => {
    const { result } = await renderHook(() => useOpenPanel(), { wrapper });
    expect(result.current.openPanel).toBeNull();
  });

  it('opening one panel closes the other', async () => {
    const { result } = await renderHook(() => useOpenPanel(), { wrapper });
    await act(async () => result.current.open('view-options'));
    expect(result.current.openPanel).toBe('view-options');
    await act(async () => result.current.open('assistant'));
    expect(result.current.openPanel).toBe('assistant');
  });

  it('closing a panel that is not open is a no-op', async () => {
    const { result } = await renderHook(() => useOpenPanel(), { wrapper });
    await act(async () => result.current.open('view-options'));
    await act(async () => result.current.close('assistant'));
    expect(result.current.openPanel).toBe('view-options');
    await act(async () => result.current.close('view-options'));
    expect(result.current.openPanel).toBeNull();
  });

  it('toggle flips the named panel', async () => {
    const { result } = await renderHook(() => useOpenPanel(), { wrapper });
    await act(async () => result.current.toggle('assistant'));
    expect(result.current.openPanel).toBe('assistant');
    await act(async () => result.current.toggle('view-options'));
    expect(result.current.openPanel).toBe('view-options');
    await act(async () => result.current.toggle('view-options'));
    expect(result.current.openPanel).toBeNull();
  });

  it('throws a clear error outside the provider', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(renderHook(() => useOpenPanel())).rejects.toThrow(/OpenPanelProvider/);
    spy.mockRestore();
  });

  it('imports nothing from the assistant runtime (feature 077 entry-chunk guard)', async () => {
    const src = fs.readFileSync(path.join(__dirname, 'use-open-panel.tsx'), 'utf8');
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).not.toMatch(/@copilotkit\/|@ag-ui\/|use-assistant/);
    }
  });
});
