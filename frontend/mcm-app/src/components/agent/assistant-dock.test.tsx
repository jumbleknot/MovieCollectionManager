/**
 * Assistant dock render smoke test (T029).
 *
 * Validates that the CopilotKit AG-UI client (@copilotkit/react-native + @ag-ui/client)
 * integrates with the app's RN 0.85 / React 19.2 runtime and that the app-wide overlay
 * dock mounts and exposes its entry control. The live AG-UI round-trip is covered by the
 * web E2E (Playwright) against a running gateway + BFF.
 */
import { render } from '@/test-support/render';

import { AssistantDock } from '@/components/agent/assistant-dock';
import { AssistantProvider } from '@/hooks/use-assistant';

describe('AssistantDock', () => {
  it('mounts inside the CopilotKit provider and shows the dock toggle', () => {
    const { getByTestId } = render(
      <AssistantProvider>
        <AssistantDock />
      </AssistantProvider>,
    );
    expect(getByTestId('assistant-dock-toggle')).toBeTruthy();
  });
});
