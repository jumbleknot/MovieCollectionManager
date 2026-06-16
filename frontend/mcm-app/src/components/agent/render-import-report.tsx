/**
 * RenderImportReport (014 enhancement 3) — collapsible "what wasn't imported" report card.
 *
 * After an import applies, the assistant emits a `render_import_report` AG-UI tool call carrying
 * the rows it could NOT import: `skipped` (caught before any write — a missing/invalid required
 * field or an in-file duplicate) and `failed` (rejected by mc-service at write time, with the
 * field-level reason). The completion message stays a concise count; this card lets the user
 * expand the per-row detail ("click here to view report"). Render-only: no token, no write.
 *
 * Universal Generative UI (constitution): one React Native component renders identically on web
 * (react-native-web) and Android.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { useRenderTool } from '@copilotkit/react-native';
import { z } from 'zod';

/** AG-UI tool name — must match the approval gate's emitted tool call (generative_ui_tools.py). */
export const RENDER_IMPORT_REPORT_TOOL = 'render_import_report';

type ReportRow = { title: string; reason: string };

export type RenderImportReportProps = {
  imported: number;
  skipped: ReportRow[];
  failed: ReportRow[];
};

function RowList({ rows, testID }: { rows: ReportRow[]; testID: string }) {
  const styles = makeStyles(useTheme());
  return (
    <View testID={testID}>
      {rows.map((r, i) => (
        <Text key={`${i}:${r.title}`} style={styles.row}>
          • {r.title || '(untitled)'} — {r.reason || 'unknown'}
        </Text>
      ))}
    </View>
  );
}

export function RenderImportReport({ imported, skipped, failed }: RenderImportReportProps) {
  const styles = makeStyles(useTheme());
  const [open, setOpen] = useState(false);
  const nSkip = skipped?.length ?? 0;
  const nFail = failed?.length ?? 0;

  return (
    <View testID="import-report" style={styles.card}>
      <Text testID="import-report-summary" style={styles.summary}>
        Imported {imported}. {nSkip} skipped, {nFail} failed.
      </Text>
      <TouchableOpacity
        testID="import-report-toggle"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
      >
        <Text style={styles.toggle}>
          {open ? '▾ Hide report' : '▸ View report on what was not imported'}
        </Text>
      </TouchableOpacity>
      {open ? (
        <View testID="import-report-detail" style={styles.detail}>
          {nSkip > 0 ? (
            <>
              <Text style={styles.sectionHeading}>Skipped ({nSkip})</Text>
              <RowList rows={skipped} testID="import-report-skipped" />
            </>
          ) : null}
          {nFail > 0 ? (
            <>
              <Text style={styles.sectionHeading}>Failed ({nFail})</Text>
              <RowList rows={failed} testID="import-report-failed" />
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const reportRow = z.object({ title: z.string(), reason: z.string() });

/** Zod schema for the `render_import_report` tool args (mirrors the prop builder). */
export const renderImportReportParameters = z.object({
  imported: z.number(),
  skipped: z.array(reportRow),
  failed: z.array(reportRow),
});

/**
 * Registers the `render_import_report` generative-UI tool so the dock renders the collapsible
 * report inline when the approval gate emits the tool call after an import. Render-only (no
 * `handler`). Mount once inside the dock.
 */
export function useRenderImportReportTool(): void {
  useRenderTool<RenderImportReportProps>({
    name: RENDER_IMPORT_REPORT_TOOL,
    description:
      'Display a collapsible report of spreadsheet-import rows that were skipped or failed, with the reason for each. Does not modify anything.',
    parameters: renderImportReportParameters,
    render: ({ args }) => (
      <RenderImportReport
        imported={args.imported ?? 0}
        skipped={args.skipped ?? []}
        failed={args.failed ?? []}
      />
    ),
  });
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  // "What wasn't imported" — a NEUTRAL surface with an error-coloured border + headings as the
  // attention cue. (Was a full errorContainer fill, which was too aggressive in dark mode —
  // feature 015 tone-down.)
  card: {
    padding: 10,
    backgroundColor: theme.surface3?.val,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.error?.val,
    marginVertical: 4,
    gap: 6,
  },
  summary: { fontFamily: 'Inter', fontSize: 14, fontWeight: '600', color: theme.onSurface?.val },
  toggle: { fontFamily: 'Inter', fontSize: 13, fontWeight: '600', color: theme.primary?.val },
  detail: { gap: 4, marginTop: 2 },
  sectionHeading: { fontFamily: 'Inter', fontSize: 12, fontWeight: '700', color: theme.error?.val, marginTop: 4 },
  row: { fontFamily: 'Inter', fontSize: 12, color: theme.onSurfaceVariant?.val },
});
