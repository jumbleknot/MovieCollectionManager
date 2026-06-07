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
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useInterrupt } from '@copilotkit/react-native';

import { ASSISTANT_AGENT_ID } from '@/hooks/use-assistant';

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
        <TouchableOpacity
          testID="approval-reject"
          accessibilityRole="button"
          disabled={decided}
          onPress={decide(onReject)}
          style={[styles.button, styles.reject, decided && styles.disabled]}
        >
          <Text style={styles.rejectText}>Reject</Text>
        </TouchableOpacity>
        <TouchableOpacity
          testID="approval-approve"
          accessibilityRole="button"
          disabled={decided}
          onPress={decide(onApprove)}
          style={[styles.button, styles.approve, decided && styles.disabled]}
        >
          <Text style={styles.approveText}>Approve</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

/**
 * Bridges the agent's LangGraph approval interrupt to the ApprovalRequest UI. The interrupt
 * surfaces as CopilotKit's `on_interrupt` custom event (ag_ui_langgraph) carrying our
 * approval_request payload as `event.value`. `resolve` resumes the run — approve applies the
 * writes (a fresh subject token is minted by the BFF /run route per POST), reject discards it
 * (FR-007). `renderInChat: false` returns the element so the custom dock can place it.
 */
export function useApprovalInterrupt(): React.ReactElement | null {
  const element = useInterrupt({
    agentId: ASSISTANT_AGENT_ID,
    renderInChat: false,
    render: ({ event, resolve }) => (
      <ApprovalRequest
        payload={event.value as ApprovalRequestPayload}
        onApprove={() => resolve({ decision: 'approved' })}
        onReject={() => resolve({ decision: 'rejected' })}
      />
    ),
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
  item: { fontSize: 13, color: '#333' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  button: { borderRadius: 8, paddingHorizontal: 16, paddingVertical: 8 },
  approve: { backgroundColor: '#2e7d32' },
  reject: { backgroundColor: '#eee', borderWidth: 1, borderColor: '#ccc' },
  disabled: { opacity: 0.5 },
  approveText: { color: '#fff', fontWeight: '600' },
  rejectText: { color: '#333', fontWeight: '600' },
});
