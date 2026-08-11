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

/**
 * How many messages may wait behind the current answer.
 *
 * A memory guard, not a product limit: eight is far above any realistic type-ahead during a single
 * reply. Going past it is refused and surfaced rather than silently displacing an earlier message,
 * because a silent displacement is the defect this queue exists to remove.
 */
const PENDING_QUEUE_LIMIT = 8;

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
  const pendingRef = useRef<string[]>([]);

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
      // Agent unavailable or mid-answer — queue and flush from the effect below.
      //
      // A QUEUE, not a slot. The single slot this replaces was overwritten by the next message, so
      // typing twice while the assistant answered lost the first one with no error and no echo —
      // the same silent-drop this hook exists to prevent, one layer in.
      if (pendingRef.current.length >= PENDING_QUEUE_LIMIT) {
        // Refused and SURFACED, never silently displaced. Dropping here would re-create the defect
        // being fixed; the bound is a memory guard, not a product limit.
        console.warn(
          `[assistant] send refused: ${PENDING_QUEUE_LIMIT} messages are already queued behind the ` +
            'current answer. Wait for the assistant to reply before sending more.',
        );
        return;
      }
      pendingRef.current.push(text);
    },
    [resolveAgent, fire],
  );

  // `agent` is a STABLE object whose `isRunning` is a mutable property, so the effect below cannot
  // see a run finish unless that property is a dependency in its own right. Hoisted here rather than
  // read inside the effect for exactly that reason.
  const isRunning = agent?.isRunning ?? false;

  // Flush a queued message once the agent becomes available — which is two conditions, not one:
  // the empty-registry tap this queue was written for, AND a run completing. The second was
  // unreachable while the dependency list was `[agent, resolveAgent, fire]`: none of the three
  // changes when a run FINISHES (both callbacks are memoised on `agent`), so a message typed
  // mid-answer was dropped permanently, silently, with zero requests to the gateway.
  useEffect(() => {
    if (pendingRef.current.length === 0) return;
    const target = resolveAgent();
    if (!target || target.isRunning) return;
    // SHIFTED BEFORE `fire`, which is what makes delivery at-most-once even if the effect runs twice
    // for one transition — React 19 StrictMode double-invokes effects in development. Sending one
    // message per flush rather than draining the whole queue keeps turns serialised: `fire` starts a
    // run, so the next flush is driven by that run completing, exactly as if the member had waited.
    const next = pendingRef.current.shift();
    if (next !== undefined) fire(target, next);
  }, [agent, isRunning, resolveAgent, fire]);

  return { run, isRunning };
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
