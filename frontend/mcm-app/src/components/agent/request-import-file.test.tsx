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

// ⚠️ STABLE DOUBLES — the same discipline as use-assistant.test.tsx, and for the same reason.
// The component now sends through `useAssistantRun`, whose flush effect is keyed on the agent
// object's identity plus its mutable `isRunning`. A double that returns a fresh object per render
// invalidates the memoised callbacks and re-runs the flush for free, repairing the bug the
// mid-answer test exists to catch (measured on feature 053).
const agentState = { isRunning: false, addMessage };
const copilotkitState = { runAgent, getAgent: () => agentState };

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
  agentState.isRunning = false;
  mockedUseAgent.mockReturnValue({ agent: agentState });
  mockedUseCopilotKit.mockReturnValue({ copilotkit: copilotkitState });
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

  // Item #337 / 064 US1. THE UPLOAD HAS ALREADY CHANGED SERVER STATE by the time this decision is
  // taken: the BFF has stashed a single-use `{handle, filename}` for this user, and the import node
  // only ever sees it if a turn arrives to consume it. Returning early because the assistant happened
  // to be mid-answer therefore does not "skip a send" — it STRANDS the upload, and the member is left
  // looking at a silent dock.
  //
  // Measured on CI run 2541 (`agent-import-disambiguate`, both attempts): a `/agent/run` was already
  // in flight at 49.183, the upload completed at 49.241, and the client-evidence ring — marked
  // `complete — nothing dropped` — records NO run POST afterwards. The spec then waited 150 s for a
  // `selection-options` element that could not appear, and the failure was read for three sessions as
  // "the model chose not to disambiguate".
  it('delivers the import turn when the upload completes mid-answer, once the run finishes', async () => {
    mockedPick.mockResolvedValue(FILE);
    uploadFile.mockResolvedValue(true);
    agentState.isRunning = true;
    const { getByTestId, rerender } = render(<RequestImportFile />);

    fireEvent.press(getByTestId('request-import-file-choose'));
    await waitFor(() => expect(uploadFile).toHaveBeenCalledWith(FILE));
    expect(addMessage).not.toHaveBeenCalled(); // queued, not sent — correct so far

    // The in-flight run completes. The agent object keeps its identity; only the mutable property
    // flips — exactly the transition the queue's effect is keyed on.
    agentState.isRunning = false;
    rerender(<RequestImportFile />);

    await waitFor(() =>
      expect(addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'user', content: expect.stringMatching(/import/i) }),
      ),
    );
    expect(runAgent).toHaveBeenCalledTimes(1);
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
