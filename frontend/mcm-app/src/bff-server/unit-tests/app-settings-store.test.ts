/**
 * Unit tests for the global app-settings store (feature 040 US3 / Item 1, T027).
 * Mocks the Mongo collection — verifies default-allowed, read-through, and upsert-with-stamp.
 */

const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();

jest.mock('@/bff-server/mongo-client', () => ({
  getAppSettingsCollection: jest.fn(async () => ({
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
  })),
}));

import { getAppSettings, setAllowSelfRegistration } from '@/bff-server/app-settings-store';

describe('app-settings-store', () => {
  beforeEach(() => jest.clearAllMocks());

  it('defaults to allowSelfRegistration=true when no document exists (SC-004)', async () => {
    mockFindOne.mockResolvedValue(null);
    expect(await getAppSettings()).toEqual({
      allowSelfRegistration: true,
      updatedBy: null,
      updatedAt: null,
    });
  });

  it('reads the stored value (disabled)', async () => {
    mockFindOne.mockResolvedValue({
      _id: 'global',
      allowSelfRegistration: false,
      updatedBy: 'admin-1',
      updatedAt: '2026-07-15T00:00:00.000Z',
    });
    const s = await getAppSettings();
    expect(s.allowSelfRegistration).toBe(false);
    expect(s.updatedBy).toBe('admin-1');
  });

  it('tolerates a partial doc (missing flag ⇒ allowed)', async () => {
    mockFindOne.mockResolvedValue({ _id: 'global', updatedBy: null, updatedAt: null });
    expect((await getAppSettings()).allowSelfRegistration).toBe(true);
  });

  it('upserts the single global doc and stamps updatedBy/updatedAt', async () => {
    mockFindOneAndUpdate.mockResolvedValue({
      allowSelfRegistration: false,
      updatedBy: 'admin-1',
      updatedAt: '2026-07-15T12:00:00.000Z',
    });
    const out = await setAllowSelfRegistration(false, 'admin-1');
    expect(out.allowSelfRegistration).toBe(false);
    expect(out.updatedBy).toBe('admin-1');

    const [filter, update, opts] = mockFindOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown>; $setOnInsert: Record<string, unknown> },
      Record<string, unknown>,
    ];
    expect(filter).toEqual({ _id: 'global' });
    expect(update.$set.allowSelfRegistration).toBe(false);
    expect(update.$set.updatedBy).toBe('admin-1');
    expect(typeof update.$set.updatedAt).toBe('string');
    expect(opts.upsert).toBe(true);
  });
});
