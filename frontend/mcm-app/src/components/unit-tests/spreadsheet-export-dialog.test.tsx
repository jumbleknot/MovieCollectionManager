/**
 * SpreadsheetExportDialog unit tests (014 US3, T047).
 *
 * Web-only entry point for the assistant export flow: a button that sends an "export my
 * collections…" turn to the agent (agent.addMessage + copilotkit.runAgent). The agent's
 * export_collection node emits a `download_export` UI-action the client then downloads. Mocks only
 * the CopilotKit agent source.
 */
import React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as copilot from '@copilotkit/react-native';

import { SpreadsheetExportDialog } from '@/components/spreadsheet-export-dialog';

jest.mock('@copilotkit/react-native', () => ({
  useAgent: jest.fn(),
  useCopilotKit: jest.fn(),
}));

const mockedUseAgent = copilot.useAgent as unknown as jest.Mock;
const mockedUseCopilotKit = copilot.useCopilotKit as unknown as jest.Mock;
const addMessage = jest.fn();
const runAgent = jest.fn();
const originalOS = Platform.OS;

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { value: 'web', writable: true });
  addMessage.mockClear();
  runAgent.mockClear().mockResolvedValue(undefined);
  mockedUseAgent.mockReturnValue({ agent: { isRunning: false, addMessage } });
  mockedUseCopilotKit.mockReturnValue({ copilotkit: { runAgent } });
});

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS, writable: true });
});

describe('SpreadsheetExportDialog', () => {
  it('renders the export button on web', () => {
    const { getByTestId } = render(<SpreadsheetExportDialog />);
    expect(getByTestId('spreadsheet-export-button')).toBeTruthy();
  });

  it('renders nothing on native (web-first parity exception)', () => {
    Object.defineProperty(Platform, 'OS', { value: 'ios', writable: true });
    const { queryByTestId } = render(<SpreadsheetExportDialog />);
    expect(queryByTestId('spreadsheet-export-button')).toBeNull();
  });

  it('sends an export turn to the agent on press', async () => {
    const { getByTestId } = render(<SpreadsheetExportDialog />);
    fireEvent.press(getByTestId('spreadsheet-export-button'));
    await waitFor(() =>
      expect(addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'user', content: expect.stringMatching(/export/i) }),
      ),
    );
    expect(runAgent).toHaveBeenCalledWith({ agent: expect.anything() });
  });

  it('does not send while a run is already in flight', () => {
    mockedUseAgent.mockReturnValue({ agent: { isRunning: true, addMessage } });
    const { getByTestId } = render(<SpreadsheetExportDialog />);
    fireEvent.press(getByTestId('spreadsheet-export-button'));
    expect(addMessage).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });
});
