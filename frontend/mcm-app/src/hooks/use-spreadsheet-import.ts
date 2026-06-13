/**
 * useSpreadsheetImport (014 US2, T037) — web spreadsheet upload for the assistant import flow.
 *
 * Uploads the selected CSV/.xlsx to the BFF (`/bff-api/agent/import-upload`), which stashes the
 * bytes in the transient store and remembers the per-user handle. The dialog then sends an
 * "import my movies…" assistant turn; the next `/agent/run` bridges that handle to the gateway,
 * so the import node parses + previews it (HITL-gated). This hook owns ONLY the upload + status;
 * the chat-message trigger lives in the dialog (CopilotKit chat), keeping this unit-testable.
 *
 * Import/export are web-first (documented parity exception); this hook is web-only.
 */

import { useState, useCallback } from 'react';

import { apiClient } from '@/bff-server/api-client';

export type SpreadsheetImportStatus = 'idle' | 'uploading' | 'uploaded' | 'error';

export interface UseSpreadsheetImportReturn {
  status: SpreadsheetImportStatus;
  filename: string | null;
  error: string | null;
  /** Upload the file; resolves true on success (status → 'uploaded'), false on failure. */
  uploadFile: (file: File) => Promise<boolean>;
  reset: () => void;
}

interface UploadResponse {
  filename?: string;
}

export function useSpreadsheetImport(): UseSpreadsheetImportReturn {
  const [status, setStatus] = useState<SpreadsheetImportStatus>('idle');
  const [filename, setFilename] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uploadFile = useCallback(async (file: File): Promise<boolean> => {
    setStatus('uploading');
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiClient.post<UploadResponse>('/bff-api/agent/import-upload', form);
      setFilename(res.data?.filename ?? file.name);
      setStatus('uploaded');
      return true;
    } catch (err) {
      const message =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        'Upload failed — please try a CSV or Excel (.xlsx) spreadsheet.';
      setError(message);
      setStatus('error');
      return false;
    }
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setFilename(null);
    setError(null);
  }, []);

  return { status, filename, error, uploadFile, reset };
}
