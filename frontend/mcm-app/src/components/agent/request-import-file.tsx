/**
 * RequestImportFile (014 US2 — UX fix) — the assistant's "choose a file" affordance.
 *
 * There is no longer an always-on "Import spreadsheet" button. An import is started by the user
 * TYPING the request (e.g. "import my movies"); the import_collection node, finding no staged
 * file, emits a `request_import_file` AG-UI tool call that the dock renders inline as this
 * component — a "Choose file…" button plus a "Cancel". Choosing opens the OS file picker, uploads
 * the file to the BFF (useSpreadsheetImport), and re-sends the import turn so the node parses +
 * previews it. Cancel just dismisses the prompt locally (no agent round-trip needed — the node set
 * no pending state).
 *
 * Web-only (import/export is a documented web-first parity exception; renders nothing on native).
 */
import React, { useCallback, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { Button } from '@mcm/design-system';
import { useAgent, useCopilotKit, useRenderTool } from '@copilotkit/react-native';
import { z } from 'zod';

import { ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';
import { useSpreadsheetImport } from '@/hooks/use-spreadsheet-import';
import { pickSpreadsheetFile } from '@/utils/pick-file';

/** AG-UI tool name — must match the import node's emitted tool call (generative_ui_tools.py). */
export const REQUEST_IMPORT_FILE_TOOL = 'request_import_file';

// The turn that drives the import node once the file is staged server-side (matches the `import`
// golden intent phrasing).
const IMPORT_PROMPT = 'import my movies from this spreadsheet';

export function RequestImportFile({ prompt }: { prompt?: string }) {
  const styles = makeStyles(useTheme());
  const { agent } = useAgent({ agentId: ASSISTANT_AGENT_ID });
  const { copilotkit } = useCopilotKit();
  const { status, error, uploadFile } = useSpreadsheetImport();
  const [cancelled, setCancelled] = useState(false);

  const choose = useCallback(async () => {
    const file = await pickSpreadsheetFile();
    if (!file) return;
    const ok = await uploadFile(file);
    if (!ok || !agent || agent.isRunning) return;
    agent.addMessage({ id: `u-${Date.now()}`, role: 'user', content: IMPORT_PROMPT });
    await copilotkit.runAgent({ agent });
  }, [uploadFile, agent, copilotkit]);

  // Web-first parity exception — no file browse/upload surface on native.
  if (Platform.OS !== 'web') return null;
  if (cancelled) {
    return (
      <Text testID="request-import-file-cancelled" style={styles.dismissed}>
        Import cancelled.
      </Text>
    );
  }

  const uploading = status === 'uploading';
  return (
    <View testID="request-import-file" style={styles.container}>
      {prompt ? <Text style={styles.prompt}>{prompt}</Text> : null}
      <View style={styles.row}>
        <Button
          variant="filled"
          size="sm"
          label={uploading ? 'Uploading…' : 'Choose file…'}
          loading={uploading}
          disabled={uploading}
          onPress={choose}
          testID="request-import-file-choose"
          accessibilityLabel="Choose a spreadsheet to import"
        />
        <Button
          variant="outlined"
          size="sm"
          label="Cancel"
          disabled={uploading}
          onPress={() => setCancelled(true)}
          testID="request-import-file-cancel"
          accessibilityLabel="Cancel the import"
        />
      </View>
      {status === 'error' && error ? (
        <Text testID="request-import-file-error" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Register the `request_import_file` generative-UI tool with CopilotKit so the dock renders the
 * Choose-file / Cancel affordance inline when the assistant asks for a file. Mount once inside the
 * dock (alongside the other render tools).
 */
export function useRequestImportFileTool(): void {
  useRenderTool<{ prompt?: string }>({
    name: REQUEST_IMPORT_FILE_TOOL,
    description: 'Prompt the user to choose a spreadsheet file to import.',
    parameters: z.object({ prompt: z.string().optional() }),
    render: ({ args }) => <RequestImportFile prompt={args.prompt} />,
  });
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  container: { gap: 6, paddingVertical: 4 },
  prompt: { fontFamily: 'Inter', fontSize: 14, color: theme.onSurface?.val },
  row: { flexDirection: 'row', gap: 8 },
  dismissed: { fontFamily: 'Inter', fontSize: 14, color: theme.onSurfaceVariant?.val, fontStyle: 'italic', paddingVertical: 4 },
  error: { fontFamily: 'Inter', fontSize: 12, color: theme.error?.val },
});
