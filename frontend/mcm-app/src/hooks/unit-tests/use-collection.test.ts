/**
 * Unit tests for useCollection hook (013 Enhancement 1)
 *
 * Fetches a single collection's display fields (the name) for the collection screen header.
 */

import { renderHook, waitFor } from '@testing-library/react-native';
import { apiClient } from '@/bff-server/api-client';
import { useCollection } from '@/hooks/use-collection';
import type { CollectionSummary } from '@/types/collection';

jest.mock('@/bff-server/api-client', () => ({
  apiClient: { get: jest.fn() },
}));

const mockedGet = jest.mocked(apiClient.get);

const COLLECTION: CollectionSummary = {
  collectionId: 'col-1',
  name: 'Wish List',
  description: null,
  isDefault: false,
  movieCount: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('useCollection', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches the single collection by id and exposes its name', async () => {
    mockedGet.mockResolvedValueOnce({ data: COLLECTION } as never);
    const { result } = renderHook(() => useCollection('col-1'));

    await waitFor(() => expect(result.current.name).toBe('Wish List'));
    expect(mockedGet).toHaveBeenCalledWith('/bff-api/collections/col-1');
  });

  it('leaves name null when the fetch fails (header simply hides)', async () => {
    mockedGet.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useCollection('col-1'));

    await waitFor(() => expect(mockedGet).toHaveBeenCalled());
    expect(result.current.name).toBeNull();
  });

  it('does not fetch when collectionId is empty', () => {
    renderHook(() => useCollection(''));
    expect(mockedGet).not.toHaveBeenCalled();
  });
});
