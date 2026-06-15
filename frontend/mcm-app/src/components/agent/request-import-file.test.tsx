/**
 * RequestImportFile unit tests (014 US2 — UX fix).
 *
 * The assistant's inline "Choose file… / Cancel" affordance (emitted by the import node when no
 * file is staged) — there is no longer an always-on upload button. Choosing picks + uploads the
 * file (useSpreadsheetImport) then re-sends the import turn (agent.addMessage + runAgent); Cancel
 * dismisses locally. Mocks only the CopilotKit agent source, the upload hook, and the file picker.
 */
import React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, waitFor } from '@/test-support/render';
import * as copilot from '@copilotkit/react-native';

import { RequestImportFile } from '@/components/agent/request-import-file';
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

describe('RequestImportFile', () => {
  it('renders Choose file… and Cancel on web', () => {
    const { getByTestId } = render(<RequestImportFile />);
    expect(getByTestId('request-import-file-choose')).toBeTruthy();
    expect(getByTestId('request-import-file-cancel')).toBeTruthy();
  });

  it('renders nothing on native (web-first parity exception)', () => {
    Object.defineProperty(Platform, 'OS', { value: 'android', writable: true });
    const { queryByTestId } = render(<RequestImportFile />);
    expect(queryByTestId('request-import-file')).toBeNull();
  });

  it('uploads the picked file then sends the import turn', async () => {
    mockedPick.mockResolvedValue(FILE);
    uploadFile.mockResolvedValue(true);
    const { getByTestId } = render(<RequestImportFile />);

    fireEvent.press(getByTestId('request-import-file-choose'));

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
    const { getByTestId } = render(<RequestImportFile />);

    fireEvent.press(getByTestId('request-import-file-choose'));

    await waitFor(() => expect(uploadFile).toHaveBeenCalled());
    expect(addMessage).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('dismisses locally when Cancel is pressed (no agent round-trip)', () => {
    const { getByTestId, queryByTestId } = render(<RequestImportFile />);
    fireEvent.press(getByTestId('request-import-file-cancel'));
    expect(getByTestId('request-import-file-cancelled')).toBeTruthy();
    expect(queryByTestId('request-import-file-choose')).toBeNull();
    expect(addMessage).not.toHaveBeenCalled();
  });

  it('shows the error message when the upload hook is in the error state', () => {
    setImportState({ status: 'error', error: 'Upload failed — please try a CSV or Excel file.' });
    const { getByTestId } = render(<RequestImportFile />);
    expect(getByTestId('request-import-file-error').props.children).toMatch(/upload failed/i);
  });
});
