/**
 * Generative-UI tool REGISTRATION (feature 081 US7, T048/T049).
 *
 * Every MCM generative-UI / UI-action tool is registered with CopilotKit as a FRONTEND TOOL that
 * carries its renderer: the tool (name, description, parameter schema) is in the core tool
 * registry, and its render function is in `renderToolCalls`, where the dock's
 * `useRenderToolCall()` finds it.
 *
 * Why this is pinned. Up to 1.70.1, `@copilotkit/react-native` shipped its OWN `useRenderTool`, a
 * thin wrapper over react-core's `useFrontendTool` — so the app's tools were frontend tools.
 * 1.79 deleted that wrapper and re-exports react-core's `useRenderTool` under the same name, which
 * is RENDER-ONLY: it registers the renderer and nothing else. The app kept importing the same name,
 * so the change was silent at runtime — the dock still draws every card, and the whole unit tier
 * stayed green (1597/1597) on the bumped-but-unmigrated code. Only `tsc` noticed, and only because
 * the generic's constraint changed shape. A frontend tool and a render-only renderer are not the
 * same thing to CopilotKit core: core `processAgentResult` acts on an assistant tool call ONLY
 * when a frontend tool of that name is registered. This file is what fails if the registration
 * kind changes again, whichever way the types go.
 *
 * Nothing is mocked: the hooks run inside the app's real `AssistantProvider`, and the assertions
 * read the real CopilotKit core instance.
 */
import React, { useEffect } from 'react';
import { render } from '@/test-support/render';
import { useCopilotKit } from '@copilotkit/react-native';

import { AssistantProvider, ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';
import { RENDER_MOVIE_CARD_TOOL, useRenderMovieCardTool } from '@/components/agent/render-movie-card';
import {
  RENDER_COLLECTION_SUMMARY_TOOL,
  useRenderCollectionSummaryTool,
} from '@/components/agent/render-collection-summary';
import {
  RENDER_DISAMBIGUATION_TOOL,
  useRenderDisambiguationTool,
} from '@/components/agent/disambiguation-options';
import { RENDER_SELECTION_TOOL, useRenderSelectionTool } from '@/components/agent/selection-options';
import {
  RENDER_MULTI_SELECT_TOOL,
  useRenderMultiSelectTool,
} from '@/components/agent/multi-select-options';
import {
  NAVIGATE_TO_COLLECTION_TOOL,
  NAVIGATE_TO_MOVIE_TOOL,
  PREFILL_ADD_MOVIE_TOOL,
  DOWNLOAD_EXPORT_TOOL,
  useUiActionTools,
} from '@/components/agent/ui-action-tools';
import {
  REQUEST_IMPORT_FILE_TOOL,
  useRequestImportFileTool,
} from '@/components/agent/request-import-file';
import {
  RENDER_IMPORT_REPORT_TOOL,
  useRenderImportReportTool,
} from '@/components/agent/render-import-report';

const ALL_TOOLS = [
  RENDER_MOVIE_CARD_TOOL,
  RENDER_COLLECTION_SUMMARY_TOOL,
  RENDER_DISAMBIGUATION_TOOL,
  RENDER_SELECTION_TOOL,
  RENDER_MULTI_SELECT_TOOL,
  NAVIGATE_TO_COLLECTION_TOOL,
  NAVIGATE_TO_MOVIE_TOOL,
  PREFILL_ADD_MOVIE_TOOL,
  DOWNLOAD_EXPORT_TOOL,
  REQUEST_IMPORT_FILE_TOOL,
  RENDER_IMPORT_REPORT_TOOL,
];

type Core = ReturnType<typeof useCopilotKit>['copilotkit'];

// The same registrations, in the same order, as the assistant panel makes them.
function RegisterAll({ onCore }: { onCore: (core: Core) => void }) {
  useRenderMovieCardTool();
  useRenderCollectionSummaryTool();
  useRenderDisambiguationTool();
  useRenderSelectionTool();
  useRenderMultiSelectTool();
  useUiActionTools();
  useRequestImportFileTool();
  useRenderImportReportTool();
  const { copilotkit } = useCopilotKit();
  useEffect(() => {
    onCore(copilotkit);
  });
  return null;
}

async function mountedCore(): Promise<Core> {
  let core: Core | undefined;
  await render(
    <AssistantProvider>
      <RegisterAll
        onCore={(c) => {
          core = c;
        }}
      />
    </AssistantProvider>,
  );
  if (!core) throw new Error('CopilotKit core was not captured');
  return core;
}

describe('generative-UI tool registration', () => {
  it.each(ALL_TOOLS)('registers %s as a frontend tool with a description', async (name) => {
    const core = await mountedCore();
    const tool = core.getTool({ toolName: name, agentId: ASSISTANT_AGENT_ID });
    expect(tool).toBeDefined();
    expect(tool?.name).toBe(name);
    expect(typeof tool?.description).toBe('string');
    expect(tool?.description?.length).toBeGreaterThan(0);
    // Render-only by design: every write is gated behind the approval flow, never a handler.
    expect(tool?.handler).toBeUndefined();
  });

  it.each(ALL_TOOLS)('registers a renderer for %s', async (name) => {
    const core = await mountedCore();
    const names = core.renderToolCalls.map((r) => r.name);
    expect(names).toContain(name);
  });
});
