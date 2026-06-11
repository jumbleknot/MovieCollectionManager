/**
 * ApprovalRequest unit tests (T037 — HITL approval UI).
 *
 * The approval_gate node pauses with a LangGraph interrupt carrying the approval_request
 * payload (per-item-visible preview — FR-006). CopilotKit's useInterrupt surfaces it and this
 * component renders the preview + Approve/Reject. These tests pin the presentational contract
 * deterministically; the live interrupt→resume round-trip is the web E2E.
 */
import { fireEvent, render } from '@testing-library/react-native';

import {
  ApprovalRequest,
  coerceApprovalPayload,
  type ApprovalRequestPayload,
} from '@/components/agent/approval-request';

const CREATE_AND_ADD: ApprovalRequestPayload = {
  type: 'approval_request',
  proposalId: 'p1',
  kind: 'batch',
  target: { collection_id: null, name: 'Sci-Fi', create_if_missing: true },
  items: [
    { itemId: 'create-collection', operation: 'create_collection', diff: {}, movie: null },
    {
      itemId: 'add-movie',
      operation: 'add',
      diff: {},
      movie: { title: 'Blade Runner', year: 1982 },
    },
  ],
};

describe('ApprovalRequest', () => {
  it('renders a per-item preview: create collection + add movie', () => {
    const { getByTestId } = render(
      <ApprovalRequest payload={CREATE_AND_ADD} onApprove={() => {}} onReject={() => {}} />,
    );
    expect(getByTestId('approval-request')).toBeTruthy();
    expect(getByTestId('approval-request-item-create-collection')).toHaveTextContent(
      'Create collection "Sci-Fi"',
    );
    expect(getByTestId('approval-request-item-add-movie')).toHaveTextContent(
      'Add Blade Runner (1982)',
    );
  });

  it('calls onApprove when the Approve button is pressed', () => {
    const onApprove = jest.fn();
    const { getByTestId } = render(
      <ApprovalRequest payload={CREATE_AND_ADD} onApprove={onApprove} onReject={() => {}} />,
    );
    fireEvent.press(getByTestId('approval-approve'));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('calls onReject when the Reject button is pressed', () => {
    const onReject = jest.fn();
    const { getByTestId } = render(
      <ApprovalRequest payload={CREATE_AND_ADD} onApprove={() => {}} onReject={onReject} />,
    );
    fireEvent.press(getByTestId('approval-reject'));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('coerces the interrupt value from a JSON string (ag_ui_langgraph emits a string)', () => {
    // The real on_interrupt custom event carries `value` as a JSON STRING, not an object.
    const payload = coerceApprovalPayload(JSON.stringify(CREATE_AND_ADD));
    expect(payload?.items).toHaveLength(2);
    expect(coerceApprovalPayload(CREATE_AND_ADD)?.proposalId).toBe('p1'); // object passthrough
    expect(coerceApprovalPayload('not json')).toBeNull();
    expect(coerceApprovalPayload({ no: 'items' })).toBeNull();
  });

  it('disables the buttons once a decision is pending (no double-submit)', () => {
    const onApprove = jest.fn();
    const { getByTestId } = render(
      <ApprovalRequest payload={CREATE_AND_ADD} onApprove={onApprove} onReject={() => {}} />,
    );
    fireEvent.press(getByTestId('approval-approve'));
    fireEvent.press(getByTestId('approval-approve'));
    expect(onApprove).toHaveBeenCalledTimes(1); // second press ignored
  });
});
