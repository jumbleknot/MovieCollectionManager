/**
 * SpreadsheetImportDialog unit tests (014 US2, T037).
 *
 * Web-only entry point for the assistant import flow: pick a CSV/.xlsx, upload it to the BFF
 * (useSpreadsheetImport), then — on success — send an "import my movies…" turn to the agent the
 * same way the dock input does (agent.addMessage + copilotkit.runAgent). Mocks only the CopilotKit
 * agent source, the upload hook, and the web file picker.
 */
import React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import * as copilot from '@copilotkit/react-native';

import { SpreadsheetImportDialog } from '@/components/spreadsheet-import-dialog';
import * as importHook from '@/hooks/use-spreadsheet-import';
import * as pickFile from '@/utils/pick-file';

jest.mock('@copilotkit/react-native', () => ({
  useAgent: jest.fn(),
  useCopilotKit: jest.fn(),
}));
jest.mock('@/hooks/use-spreadsheet-import', () => ({ useSpreadsheetImport: jest.fn() }));
jest.mock('@/utils/pick-file', () => ({ pickSpreadsheetFile: jest.fn() }));

const mockedUseAgent = copilot.useAgent as unknown as jest.Mock;
const mockedUseCopilotKit = copilot.useCopilotKit as unknown as jest.Mock;
const mockedUseImport = importHook.useSpreadsheetImport as unknown as jest.Mock;
const mockedPick = pickFile.pickSpreadsheetFile as unknown as jest.Mock;

const addMessage = jest.fn();
const runAgent = jest.fn();
const uploadFile = jest.fn();
const reset = jest.fn();
const originalOS = Platform.OS;

function setImportState(over: Partial<ReturnType<typeof importHook.useSpreadsheetImport>> = {}) {
  mockedUseImport.mockReturnValue({
    status: 'idle', filename: null, error: null, uploadFile, reset, ...over,
  });
}

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { value: 'web', writable: true });
  addMessage.mockClear();
  runAgent.mockClear().mockResolvedValue(undefined);
  uploadFile.mockReset();
  mockedPick.mockReset();
  mockedUseAgent.mockReturnValue({ agent: { isRunning: false, addMessage } });
  mockedUseCopilotKit.mockReturnValue({ copilotkit: { runAgent } });
  setImportState();
});

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { value: originalOS, writable: true });
});

const FILE = new File(['x'], 'movies.xlsx');

describe('SpreadsheetImportDialog', () => {
  it('renders the import button on web', () => {
    const { getByTestId } = render(<SpreadsheetImportDialog />);
    expect(getByTestId('spreadsheet-import-button')).toBeTruthy();
  });

  it('renders nothing on native (web-first parity exception)', () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', writable: true });
    const { queryByTestId } = render(<SpreadsheetImportDialog />);
    expect(queryByTestId('spreadsheet-import-button')).toBeNull();
  });

  it('uploads the picked file then sends an import turn to the agent', async () => {
    mockedPick.mockResolvedValue(FILE);
    uploadFile.mockResolvedValue(true);
    const { getByTestId } = render(<SpreadsheetImportDialog />);

    fireEvent.press(getByTestId('spreadsheet-import-button'));

    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(FILE));
    await waitFor(() =>
      expect(addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'user', content: expect.stringMatching(/import/i) }),
      ),
    );
    expect(runAgent).toHaveBeenCalledWith({ agent: expect.anything() });
  });

  it('does not send a turn when the upload fails', async () => {
    mockedPick.mockResolvedValue(FILE);
    uploadFile.mockResolvedValue(false);
    const { getByTestId } = render(<SpreadsheetImportDialog />);

    fireEvent.press(getByTestId('spreadsheet-import-button'));

    await waitFor(() => expect(uploadFile).toHaveBeenCalled());
    expect(addMessage).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('does nothing when the user cancels the file picker', async () => {
    mockedPick.mockResolvedValue(null);
    const { getByTestId } = render(<SpreadsheetImportDialog />);

    fireEvent.press(getByTestId('spreadsheet-import-button'));

    await waitFor(() => expect(mockedPick).toHaveBeenCalled());
    expect(uploadFile).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
  });

  it('shows the error message when the hook is in the error state', () => {
    setImportState({ status: 'error', error: 'Upload failed — please try a CSV or Excel file.' });
    const { getByTestId } = render(<SpreadsheetImportDialog />);
    expect(getByTestId('spreadsheet-import-error').props.children).toMatch(/upload failed/i);
  });
});
