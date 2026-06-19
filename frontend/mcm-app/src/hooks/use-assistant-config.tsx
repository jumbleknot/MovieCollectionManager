// Fetches the caller's non-secret assistant config from the BFF and derives whether the
// assistant is runnable (feature 018, US1 gating + US2 form). The dock mounts only when
// runnable; the Profile form uses the presence flags to render "configured" indicators.
// No secret ever reaches the client — only enabled state, provider, non-secret detail, and
// has* presence flags (FR-018).

import { useCallback, useEffect, useState } from 'react';
import type { AxiosError } from 'axios';

import { apiClient } from '@/bff-server/api-client';
import type { AgentConfigUpdate, AgentConfigView, ProbeError, ProbeStatus } from '@/types/agent-config';

const DISABLED_DEFAULT: AgentConfigView = {
  enabled: false,
  provider: 'ollama',
  ollamaBaseUrl: null,
  hasAnthropicKey: false,
  hasTmdbKey: false,
  costLimitUsd: null,
  escalationAvailable: false,
  updatedAt: null,
};

// A config is runnable (and the dock should show) only when enabled, the chosen provider's
// credential is present, and a TMDB key is on file (mirrors the server-side gate, FR-002).
export function isConfigRunnable(c: AgentConfigView): boolean {
  if (!c.enabled || !c.hasTmdbKey) return false;
  if (c.provider === 'anthropic') return c.hasAnthropicKey;
  if (c.provider === 'ollama') return Boolean(c.ollamaBaseUrl);
  return false;
}

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

export function useAssistantConfig(): UseAssistantConfig {
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
