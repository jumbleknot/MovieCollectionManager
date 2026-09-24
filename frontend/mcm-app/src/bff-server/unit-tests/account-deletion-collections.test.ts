/**
 * The real collection-delete loop (feature 076, T037/T038 — FR-017, FR-027).
 *
 * The ordering and failure tests drive the pipeline with stubs, so they never exercise this
 * loop's own logic. This does, because the loop is one of only TWO places in the feature where
 * retry-safety had to be written rather than inherited (the other is `deleteUser`).
 *
 * A 404 means the collection is already gone, which is the outcome being asked for. A retry
 * after a partial failure re-issues deletes for collections the first attempt removed, and
 * treating those as errors would make the retry fail precisely where it had otherwise worked.
 */

const mockGet = jest.fn();
const mockDelete = jest.fn();
jest.mock('@/bff-server/mc-service-client', () => ({
  createMcServiceClient: jest.fn(() => ({ get: mockGet, delete: mockDelete })),
}));

jest.mock('@/bff-server/logger', () => ({
  logger: { audit: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { defaultSteps } from '@/bff-server/account-deletion';
import { createMcServiceClient } from '@/bff-server/mc-service-client';

function httpError(status: number): Error & { response: { status: number } } {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDelete.mockResolvedValue({ status: 204 });
});

describe('deleteCollections', () => {
  it('deletes every collection the user owns', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });

    await expect(defaultSteps.deleteCollections('user-1', 'token')).resolves.toBe(3);

    expect(mockDelete).toHaveBeenCalledTimes(3);
    expect(mockDelete).toHaveBeenCalledWith('/api/v1/collections/a');
  });

  it('uses the step-up access token for the calls', async () => {
    mockGet.mockResolvedValue({ data: [] });

    await defaultSteps.deleteCollections('user-1', 'step-up-token');

    expect(createMcServiceClient).toHaveBeenCalledWith('step-up-token');
  });

  it('counts a 404 as success, so a retry completes', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'a' }, { id: 'gone' }] });
    mockDelete
      .mockResolvedValueOnce({ status: 204 })
      .mockRejectedValueOnce(httpError(404));

    await expect(defaultSteps.deleteCollections('user-1', 'token')).resolves.toBe(2);
  });

  it('completes when EVERY collection is already gone', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'a' }, { id: 'b' }] });
    mockDelete.mockRejectedValue(httpError(404));

    await expect(defaultSteps.deleteCollections('user-1', 'token')).resolves.toBe(2);
  });

  it('propagates a real failure rather than silently skipping the collection', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'a' }] });
    mockDelete.mockRejectedValue(httpError(500));

    await expect(defaultSteps.deleteCollections('user-1', 'token')).rejects.toThrow();
  });

  it('propagates a 403 — a permission problem must not read as "already deleted"', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'a' }] });
    mockDelete.mockRejectedValue(httpError(403));

    await expect(defaultSteps.deleteCollections('user-1', 'token')).rejects.toThrow();
  });

  it('stops at the first real failure rather than carrying on', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    mockDelete
      .mockResolvedValueOnce({ status: 204 })
      .mockRejectedValueOnce(httpError(500));

    await expect(defaultSteps.deleteCollections('user-1', 'token')).rejects.toThrow();
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  it('handles a user with no collections', async () => {
    mockGet.mockResolvedValue({ data: [] });

    await expect(defaultSteps.deleteCollections('user-1', 'token')).resolves.toBe(0);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('tolerates an unexpected list shape rather than throwing on it', async () => {
    mockGet.mockResolvedValue({ data: null });

    await expect(defaultSteps.deleteCollections('user-1', 'token')).resolves.toBe(0);
  });

  it('encodes the collection id into the path', async () => {
    mockGet.mockResolvedValue({ data: [{ id: 'a/b' }] });

    await defaultSteps.deleteCollections('user-1', 'token');

    expect(mockDelete).toHaveBeenCalledWith(`/api/v1/collections/${encodeURIComponent('a/b')}`);
  });
});
