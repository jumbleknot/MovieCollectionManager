/**
 * Unit tests for agent-config removal (feature 076, T007 — FR-018).
 *
 * `remove` is NOT `clear`. `clear()` exists for a different purpose — it disables the assistant
 * and wipes the secrets while deliberately KEEPING the non-secret settings, so a user who turns
 * the assistant off does not lose their configuration. Account deletion needs the document gone.
 *
 * Reaching for `clear()` here is the plausible wrong move, so it is asserted against directly.
 */

const mockCollection = {
  deleteOne: jest.fn(),
  updateOne: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
};

jest.mock('@/bff-server/mongo-client', () => ({
  getAgentConfigCollection: async () => mockCollection,
}));

import { remove, clear } from '@/bff-server/agent-config-store';

beforeEach(() => {
  jest.clearAllMocks();
  mockCollection.deleteOne.mockResolvedValue({ deletedCount: 1 });
  mockCollection.updateOne.mockResolvedValue({ modifiedCount: 1 });
});

describe('remove', () => {
  it('deletes the whole document for the user', async () => {
    await remove('user-1');

    expect(mockCollection.deleteOne).toHaveBeenCalledWith({ _id: 'user-1' });
  });

  it('is a no-op rather than an error when no document exists', async () => {
    mockCollection.deleteOne.mockResolvedValue({ deletedCount: 0 });

    await expect(remove('never-configured')).resolves.toBeUndefined();
  });

  it('does not merely update the document — it removes it', async () => {
    await remove('user-1');

    expect(mockCollection.updateOne).not.toHaveBeenCalled();
  });

  it('is distinct from clear(), which keeps the document and its non-secret settings', async () => {
    await clear('user-1');

    expect(mockCollection.updateOne).toHaveBeenCalled();
    expect(mockCollection.deleteOne).not.toHaveBeenCalled();
  });
});
