/**
 * Assistant provider (T029) — wires the CopilotKit AG-UI client to the BFF.
 *
 * `@copilotkit/react-native`'s CopilotKitProvider connects to a CopilotKit RUNTIME endpoint
 * via `runtimeUrl` (it does not accept a raw AG-UI agent — verified against the installed
 * CopilotKitNativeProviderProps; see research R6). The BFF route at runtimeUrl hosts the
 * CopilotKit runtime (`@copilotkit/runtime` + LangGraphHttpAgent → the AG-UI-native gateway)
 * — the framework's standard bridge, not bespoke translation. `credentials: "include"` sends
 * the HttpOnly session cookie so the BFF (the auth boundary) authenticates the request.
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { CopilotKitProvider, useAgent, useCopilotKit } from '@copilotkit/react-native';
import type { AbstractAgent } from '@copilotkit/react-native';

import { BFF_BASE_URL } from '@/config/bff-url';

// Agent id must match the gateway agent name (LangGraphAGUIAgent name="movie_assistant").
export const ASSISTANT_AGENT_ID = 'movie_assistant';

// Use the SAME base-URL resolver as the axios api-client (config/bff-url.ts): '' on web
// (same-origin relative → cookies sent) and an absolute native URL otherwise. Reading
// EXPO_PUBLIC_BFF_BASE_URL directly was a bug — the native build sets EXPO_PUBLIC_BFF_NATIVE_URL
// (which BFF_BASE_URL prefers), so the runtime URL stayed relative on the release APK and the
// agent /run fetch failed with "status 0 / React Native networking issue" (it never left the
// device — web works because relative resolves to the origin). See [[project-copilotkit-react-native]].
const RUNTIME_URL = `${BFF_BASE_URL}/bff-api/agent/run`;

/**
 * Resilient send path shared by the dock input and the generative-UI selection buttons.
 *
 * Why this exists: `@copilotkit/react-native@1.59.5`'s `useAgent({ agentId })` returns `null`
 * during a transient window while the agent registry populates (a `runtime_info_fetch_failed`
 * /run/info probe can momentarily empty it → "Agent movie_assistant not found"). A naive
 * `if (!agent) return` send/`choose()` then SILENTLY DROPS the action — the pick-tap navigation
 * flows (`agent-card-navigate`, `agent-navigate-movie`) flaked because of exactly this.
 *
 * Two layers of resilience:
 *  1. Resolve the agent from the live core registry (`copilotkit.getAgent`) when the hook's
 *     React-state `agent` lags — the registry is authoritative and synchronous.
 *  2. If BOTH are momentarily empty, QUEUE the message and flush it from an effect once the
 *     agent appears — so a tap inside the empty-registry window self-heals on the next render
 *     instead of being lost in the synchronous callback.
 */
export function useAssistantRun(): { run: (content: string) => void; isRunning: boolean } {
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({ agentId: ASSISTANT_AGENT_ID });
  const pendingRef = useRef<string | null>(null);

  const resolveAgent = useCallback(
    () => agent ?? copilotkit.getAgent(ASSISTANT_AGENT_ID),
    [agent, copilotkit],
  );

  const fire = useCallback(
    (target: AbstractAgent, content: string) => {
      target.addMessage({ id: `u-${Date.now()}`, role: 'user', content });
      void copilotkit.runAgent({ agent: target });
    },
    [copilotkit],
  );

  const run = useCallback(
    (content: string) => {
      const text = content.trim();
      if (!text) return;
      const target = resolveAgent();
      if (target && !target.isRunning) {
        fire(target, text);
        return;
      }
      // Agent transiently unavailable — queue and flush when it registers (see effect below).
      pendingRef.current = text;
    },
    [resolveAgent, fire],
  );

  // Flush a queued message once the agent becomes available (self-heals an empty-registry tap).
  useEffect(() => {
    const queued = pendingRef.current;
    if (!queued) return;
    const target = resolveAgent();
    if (target && !target.isRunning) {
      pendingRef.current = null;
      fire(target, queued);
    }
  }, [agent, resolveAgent, fire]);

  return { run, isRunning: agent?.isRunning ?? false };
}

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  // useSingleEndpoint: CopilotKit otherwise probes runtime sub-paths (GET `${runtimeUrl}/info`,
  // `/agents`) which Expo Router — an exact-path file router (one `run+api.ts` = one path) — 404s,
  // failing the run. Single-endpoint mode sends every request to the one `runtimeUrl` POST.
  return (
    <CopilotKitProvider runtimeUrl={RUNTIME_URL} credentials="include" useSingleEndpoint>
      {children}
    </CopilotKitProvider>
  );
}
