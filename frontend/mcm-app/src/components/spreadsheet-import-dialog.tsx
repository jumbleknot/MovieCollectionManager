/**
 * SpreadsheetImportDialog (014 US2, T037) — web entry point for the assistant import flow.
 *
 * Pick a CSV/.xlsx → upload it to the BFF (useSpreadsheetImport stashes the bytes + per-user
 * handle) → on success, send an "import my movies…" turn to the agent exactly as the dock input
 * does (agent.addMessage + copilotkit.runAgent). The next /agent/run bridges the stored handle to
 * the gateway, so the import node parses + previews it (HITL-gated). The opaque handle never
 * touches the client.
 *
 * Web-only: import/export is a documented web-first parity exception, so this renders nothing on
 * native. Mounted inside the assistant dock panel (within the CopilotKitProvider).
 */
import React, { useCallback } from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAgent, useCopilotKit } from '@copilotkit/react-native';

import { ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';
import { useSpreadsheetImport } from '@/hooks/use-spreadsheet-import';
import { pickSpreadsheetFile } from '@/utils/pick-file';

// The turn that drives the import node once the file is staged server-side (matches the
// `import` golden intent phrasing).
const IMPORT_PROMPT = 'import my movies from this spreadsheet';

export function SpreadsheetImportDialog() {
  const { agent } = useAgent({ agentId: ASSISTANT_AGENT_ID });
  const { copilotkit } = useCopilotKit();
  const { status, filename, error, uploadFile } = useSpreadsheetImport();

  const handleImport = useCallback(async () => {
    const file = await pickSpreadsheetFile();
    if (!file) return;
    const ok = await uploadFile(file);
    if (!ok || !agent || agent.isRunning) return;
    agent.addMessage({ id: `u-${Date.now()}`, role: 'user', content: IMPORT_PROMPT });
    await copilotkit.runAgent({ agent });
  }, [uploadFile, agent, copilotkit]);

  // Web-first parity exception — no file browse/upload surface on native.
  if (Platform.OS !== 'web') return null;

  const uploading = status === 'uploading';
  return (
    <View testID="spreadsheet-import" style={styles.container}>
      <TouchableOpacity
        testID="spreadsheet-import-button"
        accessibilityRole="button"
        accessibilityLabel="Import a spreadsheet of movies"
        onPress={handleImport}
        disabled={uploading}
        style={styles.button}
      >
        <Text style={styles.buttonText}>
          {uploading ? 'Uploading…' : 'Import spreadsheet'}
        </Text>
      </TouchableOpacity>
      {status === 'uploaded' && filename ? (
        <Text testID="spreadsheet-import-status" style={styles.status}>
          Importing “{filename}” — check the assistant for a preview.
        </Text>
      ) : null}
      {status === 'error' && error ? (
        <Text testID="spreadsheet-import-error" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 6 },
  button: { backgroundColor: '#eef2f6', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  buttonText: { color: '#24405a', fontWeight: '600' },
  status: { marginTop: 4, fontSize: 12, color: '#3a5a40' },
  error: { marginTop: 4, fontSize: 12, color: '#b00020' },
});
