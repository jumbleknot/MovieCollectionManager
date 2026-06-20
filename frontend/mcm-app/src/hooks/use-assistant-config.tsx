// Fetches the caller's non-secret assistant config from the BFF and derives whether the
// assistant is runnable (feature 018, US1 gating + US2 form). The dock mounts only when
// runnable; the Profile form uses the presence flags to render "configured" indicators.
// No secret ever reaches the client — only enabled state, provider, non-secret detail, and
// has* presence flags (FR-018).
//
// The config is exposed via a SINGLE shared context (AssistantConfigProvider), mirroring
// use-auth. The dock gate ((app)/_layout.tsx) and the Profile form both consume the SAME
// state, so a save() in the form refreshes the gate in-session — the dock appears/disappears
// without a reload or re-login (FR-031 / SC-012). A per-component copy would only re-fetch on
// a layout remount, which was the manual-test bug this provider fixes.

import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { AxiosError } from 'axios';

import { apiClient } from '@/bff-server/api-client';
import {
  DISABLED_AGENT_CONFIG_VIEW,
  isViewRunnable,
  type AgentConfigUpdate,
  type AgentConfigView,
  type ProbeError,
  type ProbeStatus,
} from '@/types/agent-config';

const DISABLED_DEFAULT = DISABLED_AGENT_CONFIG_VIEW;

// A config is runnable (and the dock should show) only when enabled, the chosen provider's
// credential is present, and a TMDB key is on file. Delegates to the SAME shared predicate as
// the server-side /run gate (isRunnableFrom) so client and server never diverge (FR-002).
export const isConfigRunnable = isViewRunnable;

// PUT outcome: ok (config refreshed) or a per-field validation failure (400 shape / 422 probe).
export type SaveOutcome = { ok: true } | { ok: false; status: number; errors: ProbeError[] };

// POST /config/test outcome: per-credential status keyed by field (US3), or an error.
export type TestOutcome =
  | { ok: true; results: Record<string, ProbeStatus> }
  | { ok: false; status: number; message: string };

export interface UseAssistantConfig {
  config: AgentConfigView;
  loading: boolean;
  runnable: boolean;
  refresh: () => Promise<void>;
  save: (update: AgentConfigUpdate) => Promise<SaveOutcome>;
  test: () => Promise<TestOutcome>;
}

// The shared config state — runs the fetch/save/test logic once per provider mount. Null
// outside a provider so useAssistantConfig can fail loudly (mirrors use-auth).
const AssistantConfigContext = createContext<UseAssistantConfig | null>(null);

function useAssistantConfigState(): UseAssistantConfig {
  const [config, setConfig] = useState<AgentConfigView>(DISABLED_DEFAULT);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await apiClient.get<AgentConfigView>('/bff-api/agent/config');
      setConfig(res.data);
    } catch {
      // On any error (incl. 401 before auth settles) treat as disabled — the dock stays hidden.
      setConfig(DISABLED_DEFAULT);
    } finally {
      setLoading(false);
    }
  }, []);

  // Validate-on-save PUT. On success the local view is refreshed so the dock gate + presence
  // flags react immediately. On a 400/422 the per-field errors are surfaced (no secret echoed).
  const save = useCallback(
    async (update: AgentConfigUpdate): Promise<SaveOutcome> => {
      try {
        await apiClient.put('/bff-api/agent/config', update);
        await refresh();
        return { ok: true };
      } catch (e) {
        const ax = e as AxiosError<{ errors?: ProbeError[] }>;
        return {
          ok: false,
          status: ax.response?.status ?? 0,
          errors: ax.response?.data?.errors ?? [],
        };
      }
    },
    [refresh],
  );

  // Re-test the already-stored, server-decrypted credentials (US3 — endpoint lands in T035).
  const test = useCallback(async (): Promise<TestOutcome> => {
    try {
      const res = await apiClient.post<Record<string, ProbeStatus>>('/bff-api/agent/config/test');
      return { ok: true, results: res.data };
    } catch (e) {
      const ax = e as AxiosError<{ title?: string }>;
      return {
        ok: false,
        status: ax.response?.status ?? 0,
        message: ax.response?.data?.title ?? 'Could not test the stored credentials',
      };
    }
  }, []);

  useEffect(() => {
    // Async IIFE so the state updates happen after an await (never synchronously in the
    // effect body) — mirrors use-auth's mount fetch and satisfies the cascading-render rule.
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  return { config, loading, runnable: isConfigRunnable(config), refresh, save, test };
}

// Provides the single shared assistant-config state to its subtree. Mount it inside the
// authenticated (app) layout so both the dock gate and the Profile form observe one state
// (FR-031): a save in the form refreshes the gate in-session — no reload / re-login.
export function AssistantConfigProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const value = useAssistantConfigState();
  return (
    <AssistantConfigContext.Provider value={value}>{children}</AssistantConfigContext.Provider>
  );
}

// Reads the shared assistant-config state. Must be used within an AssistantConfigProvider so
// every consumer shares one state (a stale per-component copy was the FR-031 bug).
export function useAssistantConfig(): UseAssistantConfig {
  const ctx = useContext(AssistantConfigContext);
  if (!ctx) throw new Error('useAssistantConfig must be used within AssistantConfigProvider');
  return ctx;
}
