/**
 * SpreadsheetExportDialog (014 US3, T047) — web entry point for the assistant export flow.
 *
 * A button that asks the assistant to export the user's collections to a spreadsheet. The
 * export_collection node builds the workbook (spreadsheet-mcp) and emits a `download_export`
 * UI-action that the dock's UI-action tools download. Read-only — no upload, no HITL gate.
 *
 * Web-only: import/export is a documented web-first parity exception (renders nothing on native).
 * Mounted inside the assistant dock panel (within the CopilotKitProvider).
 */
import React from 'react';
import { Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { useSpreadsheetExport } from '@/hooks/use-spreadsheet-export';

export function SpreadsheetExportDialog() {
  const { requestExport, isRunning } = useSpreadsheetExport();

  // Web-first parity exception — no download surface on native.
  if (Platform.OS !== 'web') return null;

  return (
    <View testID="spreadsheet-export" style={styles.container}>
      <TouchableOpacity
        testID="spreadsheet-export-button"
        accessibilityRole="button"
        accessibilityLabel="Export your collections to a spreadsheet"
        onPress={requestExport}
        disabled={isRunning}
        style={styles.button}
      >
        <Text style={styles.buttonText}>Export collections</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 6 },
  button: { backgroundColor: '#eef2f6', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 },
  buttonText: { color: '#24405a', fontWeight: '600' },
});
