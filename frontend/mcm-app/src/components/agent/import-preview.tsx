/**
 * ImportPreviewCard (014 US2 — UX fix) — confirm-once summary for a spreadsheet import.
 *
 * A spreadsheet import has hundreds of rows, so the assistant does NOT list every movie as a
 * separate "Add this item" line (the original card was unscrollable and the Approve button sat
 * below the fold). Instead the import_collection node sends a tab-level SUMMARY via the same
 * approval interrupt (build_approval_request → `type: "import_preview"`, FR-020): one row per
 * eligible tab showing its target collection and create/update counts, with a checkbox to exclude
 * a whole tab (FR-020a). Approve writes everything (chunked internally, no further prompts);
 * Cancel writes nothing (SC-009). The Approve/Cancel actions are pinned below a bounded,
 * scrollable tab list so they are always reachable regardless of tab count.
 */
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

type ImportColumnMapping = {
  header: string;
  attribute: string | null;
  confidence: string;
};

type ImportTabSummary = {
  tabName: string;
  collectionName: string;
  createCount: number;
  updateCount: number;
  skippedCount?: number;
  /** Resolved spreadsheet-header → movie-field mapping for this tab (enhancement 1). */
  columnMappings?: ImportColumnMapping[];
  /** One sample resolved movie, so the user can see real values per mapped field. */
  sampleMovie?: Record<string, unknown> | null;
};

/** Render a sample movie's value for display: arrays joined, booleans Yes/No, blank as "—". */
function formatSampleValue(value: unknown): string {
  if (value == null || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    return value
      .map((v) =>
        v && typeof v === 'object'
          ? // externalIds-style objects: show system:uniqueId
            [((v as Record<string, unknown>).system ?? ''), ((v as Record<string, unknown>).uniqueId ?? '')]
              .filter(Boolean)
              .join(':')
          : String(v),
      )
      .join(', ');
  }
  return String(value);
}

export type ImportPreviewPayload = {
  type: string;
  proposalId: string;
  summary: {
    tabs: ImportTabSummary[];
    ignoredTabs?: string[];
    totalCreate?: number;
    totalUpdate?: number;
  };
};

/**
 * Coerce a CopilotKit interrupt `event.value` into an import-preview payload. ag_ui_langgraph
 * emits the interrupt value as a JSON STRING, so parse a string; pass an object through. Returns
 * null unless it is a usable import_preview (has a `summary.tabs` array) so the caller can fall
 * back to the per-item approval card.
 */
export function coerceImportPreviewPayload(value: unknown): ImportPreviewPayload | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    (parsed as ImportPreviewPayload).type === 'import_preview' &&
    Array.isArray((parsed as ImportPreviewPayload).summary?.tabs)
  ) {
    return parsed as ImportPreviewPayload;
  }
  return null;
}

export function ImportPreviewCard({
  payload,
  onApprove,
  onReject,
}: {
  payload: ImportPreviewPayload;
  /** Approve the import; `excludedTabs` are the tabs the user unchecked (FR-020a). */
  onApprove: (excludedTabs: string[]) => void;
  onReject: () => void;
}) {
  const [decided, setDecided] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tabs = payload.summary.tabs;
  const ignored = payload.summary.ignoredTabs ?? [];

  const toggle = (name: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const toggleExpanded = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const included = tabs.filter((t) => !excluded.has(t.tabName));
  const totalAdd = included.reduce((s, t) => s + t.createCount, 0);
  const totalUpd = included.reduce((s, t) => s + t.updateCount, 0);

  const approve = () => {
    if (decided || included.length === 0) return;
    setDecided(true);
    onApprove([...excluded]);
  };
  const reject = () => {
    if (decided) return;
    setDecided(true);
    onReject();
  };

  return (
    <View testID="import-preview" style={styles.card}>
      <Text style={styles.heading}>Import preview</Text>
      <ScrollView style={styles.tabList} testID="import-preview-tabs">
        {tabs.map((t) => {
          const isExcluded = excluded.has(t.tabName);
          const mappings = (t.columnMappings ?? []).filter((m) => m.attribute);
          const isExpanded = expanded.has(t.tabName);
          return (
            <View key={t.tabName} style={[styles.tab, isExcluded && styles.tabExcluded]}>
              <TouchableOpacity
                testID={`import-preview-tab-${t.tabName}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: !isExcluded }}
                onPress={() => toggle(t.tabName)}
                disabled={decided}
              >
                <Text style={styles.tabTitle}>
                  {isExcluded ? '☐' : '☑'} {t.tabName} → {t.collectionName}
                </Text>
                <Text style={styles.tabCounts}>
                  {t.createCount} to add, {t.updateCount} to update
                  {t.skippedCount ? `, ${t.skippedCount} skipped` : ''}
                </Text>
              </TouchableOpacity>
              {mappings.length > 0 ? (
                <TouchableOpacity
                  testID={`import-preview-mapping-toggle-${t.tabName}`}
                  accessibilityRole="button"
                  onPress={() => toggleExpanded(t.tabName)}
                >
                  <Text style={styles.mappingToggle}>
                    {isExpanded ? '▾' : '▸'} {isExpanded ? 'Hide' : 'Show'} field mapping (sample)
                  </Text>
                </TouchableOpacity>
              ) : null}
              {isExpanded && mappings.length > 0 ? (
                <View testID={`import-preview-mapping-${t.tabName}`} style={styles.mapping}>
                  {mappings.map((m) => (
                    <Text key={m.header} style={styles.mappingRow}>
                      {m.header} → {m.attribute}
                      {`: ${formatSampleValue(t.sampleMovie?.[m.attribute as string])}`}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
      {ignored.length > 0 ? (
        <>
          <Text testID="import-preview-ignored" style={styles.ignored}>
            Ignored tabs: {ignored.join(', ')}
          </Text>
          <Text testID="import-preview-ignored-hint" style={styles.ignoredHint}>
            A tab must contain at least Title, Year, and Content Type.
          </Text>
        </>
      ) : null}
      <Text testID="import-preview-total" style={styles.total}>
        {totalAdd} to add, {totalUpd} to update
      </Text>
      <View style={styles.actions}>
        <TouchableOpacity
          testID="import-preview-cancel"
          accessibilityRole="button"
          disabled={decided}
          onPress={reject}
          style={[styles.button, styles.reject, decided && styles.disabled]}
        >
          <Text style={styles.rejectText}>Cancel</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="import-preview-approve"
          accessibilityRole="button"
          disabled={decided || included.length === 0}
          onPress={approve}
          style={[
            styles.button,
            styles.approve,
            (decided || included.length === 0) && styles.disabled,
          ]}
        >
          <Text style={styles.approveText}>Approve import</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff8e6',
    borderWidth: 1,
    borderColor: '#e0c97f',
    borderRadius: 10,
    padding: 10,
    marginVertical: 4,
    gap: 6,
  },
  heading: { fontSize: 14, fontWeight: '600', color: '#5c4d00' },
  // Bounded so a many-tab import never pushes the pinned Approve/Cancel below the fold.
  tabList: { maxHeight: 160 },
  tab: {
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: '#fffdf5',
    borderWidth: 1,
    borderColor: '#ecdca8',
    marginBottom: 4,
  },
  tabExcluded: { opacity: 0.55 },
  tabTitle: { fontSize: 13, color: '#3a3000', fontWeight: '600' },
  tabCounts: { fontSize: 12, color: '#5c4d00' },
  mappingToggle: { fontSize: 12, color: '#7a5c00', fontWeight: '600', marginTop: 4 },
  mapping: {
    marginTop: 4,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#ecdca8',
    gap: 2,
  },
  mappingRow: { fontSize: 12, color: '#3a3000' },
  ignored: { fontSize: 12, color: '#7a6a2a', fontStyle: 'italic' },
  ignoredHint: { fontSize: 11, color: '#7a6a2a' },
  total: { fontSize: 13, color: '#3a3000', fontWeight: '600' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  button: { borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  approve: { backgroundColor: '#2e7d32' },
  reject: { backgroundColor: '#eee', borderWidth: 1, borderColor: '#ccc' },
  disabled: { opacity: 0.5 },
  approveText: { color: '#fff', fontWeight: '600' },
  rejectText: { color: '#333', fontWeight: '600' },
});
