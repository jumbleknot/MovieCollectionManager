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
import React from 'react';
import { CopilotKitProvider } from '@copilotkit/react-native';

// Agent id must match the gateway agent name (LangGraphAGUIAgent name="movie_assistant").
export const ASSISTANT_AGENT_ID = 'movie_assistant';

// Relative on web (same-origin → cookies sent). EXPO_PUBLIC_BFF_BASE_URL is set for native.
const BFF_BASE = process.env.EXPO_PUBLIC_BFF_BASE_URL ?? '';
const RUNTIME_URL = `${BFF_BASE}/bff-api/agent/run`;

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
