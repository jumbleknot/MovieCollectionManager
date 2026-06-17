/**
 * ApprovalRequest (T037) — HITL approval UI for the agent's write proposals.
 *
 * The approval_gate node pauses with a LangGraph interrupt carrying an approval_request payload
 * (contract: generative-ui-and-actions.md / approval_gate.build_approval_request) — every item
 * individually visible (FR-006), no token (SC-004). CopilotKit's useInterrupt surfaces it; this
 * component renders the per-item preview + Approve/Reject. The decision is sent back via the
 * interrupt's `resolve` (see useApprovalInterrupt), which resumes the run so the writes apply
 * (approve) or nothing happens (reject — FR-007). Buttons disable after the first press so a
 * proposal can't be double-submitted.
 */
import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '@tamagui/core';
import { Button } from '@mcm/design-system';
import { useInterrupt } from '@copilotkit/react-native';

import { ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';
import { ImportPreviewCard, coerceImportPreviewPayload } from '@/components/agent/import-preview';

type ApprovalItem = {
  itemId: string;
  operation: 'create_collection' | 'add' | 'update' | 'remove';
  diff?: Record<string, unknown>;
  movie?: { title?: string; year?: number | null } | null;
};

export type ApprovalRequestPayload = {
  type: string;
  proposalId: string;
  kind: string;
  target?: { collection_id?: string | null; name?: string | null; create_if_missing?: boolean } | null;
  items: ApprovalItem[];
};

export function ApprovalRequest({
  payload,
  onApprove,
  onReject,
}: {
  payload: ApprovalRequestPayload;
  onApprove: () => void;
  onReject: () => void;
}) {
  const styles = makeStyles(useTheme());
  const [decided, setDecided] = useState(false);

  const decide = (fn: () => void) => () => {
    if (decided) return; // guard against double-submit
    setDecided(true);
    fn();
  };

  return (
    <View testID="approval-request" style={styles.card}>
      <Text style={styles.heading}>Approve these changes?</Text>
      {payload.items.map((item) => (
        <Text
          key={item.itemId}
          testID={`approval-request-item-${item.itemId}`}
          style={styles.item}
        >
          {itemLabel(item, payload.target)}
        </Text>
      ))}
      <View style={styles.actions}>
        <Button
          variant="outlined"
          size="sm"
          label="Reject"
          disabled={decided}
          onPress={decide(onReject)}
          testID="approval-reject"
          accessibilityLabel="Reject"
        />
        <Button
          variant="filled"
          size="sm"
          label="Approve"
          disabled={decided}
          onPress={decide(onApprove)}
          testID="approval-approve"
          accessibilityLabel="Approve"
        />
      </View>
    </View>
  );
}

/**
 * Coerce a CopilotKit interrupt `event.value` into the approval payload. ag_ui_langgraph emits
 * the LangGraph interrupt value as a JSON STRING on the AG-UI custom event (not a parsed object),
 * so the string must be parsed; an already-parsed object is passed through. Returns null on
 * anything that isn't a usable approval_request (so the dock renders nothing rather than crashing).
 */
export function coerceApprovalPayload(value: unknown): ApprovalRequestPayload | null {
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
    Array.isArray((parsed as ApprovalRequestPayload).items)
  ) {
    return parsed as ApprovalRequestPayload;
  }
  return null;
}

/**
 * Bridges the agent's LangGraph approval interrupt to the ApprovalRequest UI. The interrupt
 * surfaces as CopilotKit's `on_interrupt` custom event (ag_ui_langgraph) carrying our
 * approval_request payload as `event.value` (a JSON string). `resolve` resumes the run — approve
 * applies the writes (a fresh subject token is minted by the BFF /run route per POST), reject
 * discards it (FR-007). `renderInChat: false` returns the element so the custom dock places it.
 */
export function useApprovalInterrupt(onApproved?: () => void): React.ReactElement | null {
  const element = useInterrupt({
    agentId: ASSISTANT_AGENT_ID,
    renderInChat: false,
    render: ({ event, resolve }) => {
      // A spreadsheet import surfaces a confirm-once SUMMARY (with whole-tab exclude toggles),
      // not the per-item approval card — both ride the same approval interrupt channel.
      const importPayload = coerceImportPreviewPayload(event.value);
      if (importPayload) {
        return (
          <ImportPreviewCard
            payload={importPayload}
            onApprove={(excludedTabs) => {
              onApproved?.();
              resolve({ decision: 'approved', excludedTabs });
            }}
            onReject={() => resolve({ decision: 'rejected' })}
          />
        );
      }
      const payload = coerceApprovalPayload(event.value);
      if (!payload) return <></>;
      return (
        <ApprovalRequest
          payload={payload}
          // `onApproved` marks that this run will apply a write, so the dock can refresh the
          // on-screen list once the resumed run finishes (T072). Reject changes nothing (FR-007).
          onApprove={() => {
            onApproved?.();
            resolve({ decision: 'approved' });
          }}
          onReject={() => resolve({ decision: 'rejected' })}
        />
      );
    },
  });
  return (element as React.ReactElement | null) ?? null;
}

function itemLabel(item: ApprovalItem, target: ApprovalRequestPayload['target']): string {
  const movie = item.movie;
  const movieLabel = movie?.title
    ? `${movie.title}${movie.year ? ` (${movie.year})` : ''}`
    : 'this item';
  switch (item.operation) {
    case 'create_collection':
      return `Create collection "${target?.name ?? ''}"`;
    case 'add':
      return `Add ${movieLabel}`;
    case 'update':
      return `Update ${movieLabel}`;
    case 'remove':
      return `Remove ${movieLabel}`;
    default:
      return movieLabel;
  }
}

type Theme = ReturnType<typeof useTheme>;

const makeStyles = (theme: Theme) => StyleSheet.create({
  // HITL approval card — an attention surface (primaryContainer) distinct from
  // ordinary message bubbles, so a write proposal reads as "needs your decision".
  card: {
    backgroundColor: theme.surface3?.val,
    borderWidth: 1,
    borderColor: theme.primary?.val,
    borderRadius: 10,
    padding: 10,
    marginVertical: 4,
    gap: 6,
  },
  heading: { fontFamily: 'Outfit', fontSize: 14, fontWeight: '600', color: theme.onSurface?.val },
  item: { fontFamily: 'Inter', fontSize: 14, color: theme.onSurfaceVariant?.val },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
});
