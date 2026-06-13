/**
 * useSpreadsheetExport (014 US3, T047) — trigger the assistant export flow.
 *
 * Sends an "export my collections…" turn to the agent the same way the dock input does
 * (agent.addMessage + copilotkit.runAgent). The export_collection node reads the user's
 * collections, builds the workbook via spreadsheet-mcp, and emits a `download_export` UI-action
 * the client downloads. No upload — export is read-only.
 *
 * Import/export are web-first (documented parity exception).
 */
import { useCallback } from 'react';
import { useAgent, useCopilotKit } from '@copilotkit/react-native';

import { ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';

// Matches the `export` golden intent phrasing; defaults to all collections (the node exports all
// when no selection is bridged).
const EXPORT_PROMPT = 'export my collections to a spreadsheet';

export interface UseSpreadsheetExportReturn {
  requestExport: () => Promise<void>;
  isRunning: boolean;
}

export function useSpreadsheetExport(): UseSpreadsheetExportReturn {
  const { agent } = useAgent({ agentId: ASSISTANT_AGENT_ID });
  const { copilotkit } = useCopilotKit();

  const requestExport = useCallback(async () => {
    if (!agent || agent.isRunning) return;
    agent.addMessage({ id: `u-${Date.now()}`, role: 'user', content: EXPORT_PROMPT });
    await copilotkit.runAgent({ agent });
  }, [agent, copilotkit]);

  return { requestExport, isRunning: agent?.isRunning ?? false };
}
