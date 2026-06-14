/**
 * ImportPreviewCard unit tests (014 US2 — UX fix).
 *
 * An import previews as a confirm-once tab-level SUMMARY (not a per-item wall of "Add this item"
 * lines). These tests pin: the summary renders per-tab counts, the Approve/Cancel actions are
 * present (and reachable — they sit outside the bounded tab scroll), excluding a tab is reported
 * back in `excludedTabs`, and a large import is summarized by counts rather than listed row-by-row.
 */
import { fireEvent, render } from '@testing-library/react-native';

import {
  ImportPreviewCard,
  coerceImportPreviewPayload,
  type ImportPreviewPayload,
} from '@/components/agent/import-preview';

const TWO_TABS: ImportPreviewPayload = {
  type: 'import_preview',
  proposalId: 'import:t1',
  summary: {
    tabs: [
      { tabName: 'Sci-Fi', collectionName: 'My Sci-Fi', createCount: 200, updateCount: 0 },
      { tabName: 'Horror', collectionName: 'My Horror', createCount: 5, updateCount: 2 },
    ],
    ignoredTabs: ['Lists'],
    totalCreate: 205,
    totalUpdate: 2,
  },
};

describe('ImportPreviewCard', () => {
  it('renders a per-tab summary with counts instead of listing every movie', () => {
    const { getByTestId } = render(
      <ImportPreviewCard payload={TWO_TABS} onApprove={() => {}} onReject={() => {}} />,
    );
    expect(getByTestId('import-preview')).toBeTruthy();
    expect(getByTestId('import-preview-tab-Sci-Fi')).toHaveTextContent(/My Sci-Fi/);
    expect(getByTestId('import-preview-tab-Sci-Fi')).toHaveTextContent(/200 to add, 0 to update/);
    expect(getByTestId('import-preview-ignored')).toHaveTextContent(/Lists/);
    expect(getByTestId('import-preview-total')).toHaveTextContent(/205 to add, 2 to update/);
  });

  it('approves the whole import (no exclusions) by default', () => {
    const onApprove = jest.fn();
    const { getByTestId } = render(
      <ImportPreviewCard payload={TWO_TABS} onApprove={onApprove} onReject={() => {}} />,
    );
    fireEvent.press(getByTestId('import-preview-approve'));
    expect(onApprove).toHaveBeenCalledWith([]);
  });

  it('excludes an unchecked tab and reports it in excludedTabs (FR-020a)', () => {
    const onApprove = jest.fn();
    const { getByTestId } = render(
      <ImportPreviewCard payload={TWO_TABS} onApprove={onApprove} onReject={() => {}} />,
    );
    fireEvent.press(getByTestId('import-preview-tab-Horror')); // uncheck Horror
    expect(getByTestId('import-preview-total')).toHaveTextContent(/200 to add, 0 to update/);
    fireEvent.press(getByTestId('import-preview-approve'));
    expect(onApprove).toHaveBeenCalledWith(['Horror']);
  });

  it('cancels without writing anything (SC-009)', () => {
    const onReject = jest.fn();
    const { getByTestId } = render(
      <ImportPreviewCard payload={TWO_TABS} onApprove={() => {}} onReject={onReject} />,
    );
    fireEvent.press(getByTestId('import-preview-cancel'));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('disables Approve once every tab is excluded (nothing left to import)', () => {
    const onApprove = jest.fn();
    const single: ImportPreviewPayload = {
      type: 'import_preview',
      proposalId: 'import:t2',
      summary: {
        tabs: [{ tabName: 'Sci-Fi', collectionName: 'My Sci-Fi', createCount: 3, updateCount: 0 }],
        totalCreate: 3,
        totalUpdate: 0,
      },
    };
    const { getByTestId } = render(
      <ImportPreviewCard payload={single} onApprove={onApprove} onReject={() => {}} />,
    );
    fireEvent.press(getByTestId('import-preview-tab-Sci-Fi')); // exclude the only tab
    fireEvent.press(getByTestId('import-preview-approve'));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('does not double-submit once a decision is made', () => {
    const onApprove = jest.fn();
    const { getByTestId } = render(
      <ImportPreviewCard payload={TWO_TABS} onApprove={onApprove} onReject={() => {}} />,
    );
    fireEvent.press(getByTestId('import-preview-approve'));
    fireEvent.press(getByTestId('import-preview-approve'));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('coerces the interrupt value from a JSON string and rejects non-import payloads', () => {
    expect(coerceImportPreviewPayload(JSON.stringify(TWO_TABS))?.summary.tabs).toHaveLength(2);
    expect(coerceImportPreviewPayload(TWO_TABS)?.proposalId).toBe('import:t1'); // object passthrough
    expect(coerceImportPreviewPayload('not json')).toBeNull();
    // A per-item approval_request payload is NOT an import preview.
    expect(coerceImportPreviewPayload({ type: 'approval_request', items: [] })).toBeNull();
  });
});
