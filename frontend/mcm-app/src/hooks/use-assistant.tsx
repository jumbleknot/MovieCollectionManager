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
