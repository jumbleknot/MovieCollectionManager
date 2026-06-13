/**
 * Unit tests for useSpreadsheetImport (014 US2, T037) — upload + status transitions.
 */

import { renderHook, act } from '@testing-library/react-native';

import { apiClient } from '@/bff-server/api-client';
import { useSpreadsheetImport } from '@/hooks/use-spreadsheet-import';

jest.mock('@/bff-server/api-client', () => ({
  apiClient: { post: jest.fn() },
}));

const mockedPost = jest.mocked(apiClient.post);

function makeFile(name = 'movies.xlsx'): File {
  return new File([new Uint8Array([1, 2, 3])], name);
}

beforeEach(() => jest.clearAllMocks());

it('starts idle', () => {
  const { result } = renderHook(() => useSpreadsheetImport());
  expect(result.current.status).toBe('idle');
  expect(result.current.filename).toBeNull();
});

it('uploads a file and transitions idle → uploaded with the server filename', async () => {
  mockedPost.mockResolvedValueOnce({ data: { filename: 'movies.xlsx' } } as never);
  const { result } = renderHook(() => useSpreadsheetImport());

  let ok = false;
  await act(async () => {
    ok = await result.current.uploadFile(makeFile());
  });

  expect(ok).toBe(true);
  expect(result.current.status).toBe('uploaded');
  expect(result.current.filename).toBe('movies.xlsx');
  // POSTs multipart to the import-upload route.
  expect(mockedPost).toHaveBeenCalledWith('/bff-api/agent/import-upload', expect.any(FormData));
  const form = mockedPost.mock.calls[0][1] as FormData;
  expect(form.get('file')).toBeInstanceOf(File);
});

it('falls back to the local filename when the response omits one', async () => {
  mockedPost.mockResolvedValueOnce({ data: {} } as never);
  const { result } = renderHook(() => useSpreadsheetImport());
  await act(async () => {
    await result.current.uploadFile(makeFile('local.csv'));
  });
  expect(result.current.filename).toBe('local.csv');
});

it('sets an error and returns false on a failed upload', async () => {
  mockedPost.mockRejectedValueOnce({ response: { data: { detail: 'File is empty or too large' } } });
  const { result } = renderHook(() => useSpreadsheetImport());

  let ok = true;
  await act(async () => {
    ok = await result.current.uploadFile(makeFile());
  });

  expect(ok).toBe(false);
  expect(result.current.status).toBe('error');
  expect(result.current.error).toBe('File is empty or too large');
});

it('reset returns to idle', async () => {
  mockedPost.mockResolvedValueOnce({ data: { filename: 'x.xlsx' } } as never);
  const { result } = renderHook(() => useSpreadsheetImport());
  await act(async () => {
    await result.current.uploadFile(makeFile());
  });
  act(() => result.current.reset());
  expect(result.current.status).toBe('idle');
  expect(result.current.filename).toBeNull();
  expect(result.current.error).toBeNull();
});
