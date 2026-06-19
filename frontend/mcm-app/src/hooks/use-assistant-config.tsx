// Fetches the caller's non-secret assistant config from the BFF and derives whether the
// assistant is runnable (feature 018, US1 gating + US2 form). The dock mounts only when
// runnable; the Profile form uses the presence flags to render "configured" indicators.
// No secret ever reaches the client — only enabled state, provider, non-secret detail, and
// has* presence flags (FR-018).

import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '@/bff-server/api-client';
import type { AgentConfigView } from '@/types/agent-config';

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

export interface UseAssistantConfig {
  config: AgentConfigView;
  loading: boolean;
  runnable: boolean;
  refresh: () => Promise<void>;
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

  useEffect(() => {
    // Async IIFE so the state updates happen after an await (never synchronously in the
    // effect body) — mirrors use-auth's mount fetch and satisfies the cascading-render rule.
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  return { config, loading, runnable: isConfigRunnable(config), refresh };
}
