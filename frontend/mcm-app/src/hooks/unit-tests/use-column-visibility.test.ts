import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useColumnVisibility } from '../use-column-visibility';

import AsyncStorage from '@react-native-async-storage/async-storage';

// Minimal in-memory AsyncStorage mock (v3 removed the jest/ mock file)
const store: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn((key: string) => Promise.resolve(store[key] ?? null)),
    setItem: jest.fn((key: string, val: string) => { store[key] = val; return Promise.resolve(); }),
    removeItem: jest.fn((key: string) => { delete store[key]; return Promise.resolve(); }),
    clear: jest.fn(() => { Object.keys(store).forEach(k => delete store[k]); return Promise.resolve(); }),
  },
}));

const USER_A = 'user-a';
const USER_B = 'user-b';
const STORAGE_KEY_A = `@mcm:columnVisibility:${USER_A}`;

describe('useColumnVisibility', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    jest.clearAllMocks();
  });

  it('returns FR-018 defaults when AsyncStorage is empty', async () => {
    const { result } = renderHook(() => useColumnVisibility(USER_A));
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.visibleColumns.year).toBe(true);
    expect(result.current.visibleColumns.ownedMedia).toBe(true);
    expect(result.current.visibleColumns.ripQuality).toBe(true);
    expect(result.current.visibleColumns.language).toBe(false);
  });

  it('loads previously persisted column set from AsyncStorage on mount', async () => {
    // year/contentType are forced true (FR-019b); use toggleable columns here.
    const stored = JSON.stringify({ language: true, ownedMedia: false });
    await AsyncStorage.setItem(STORAGE_KEY_A, stored);

    const { result } = renderHook(() => useColumnVisibility(USER_A));
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.visibleColumns.language).toBe(true);
    expect(result.current.visibleColumns.ownedMedia).toBe(false);
  });

  it('toggleColumn flips a column and writes updated state to AsyncStorage', async () => {
    const { result } = renderHook(() => useColumnVisibility(USER_A));
    await waitFor(() => expect(result.current.isLoaded).toBe(true));

    expect(result.current.visibleColumns.year).toBe(true);
    act(() => { result.current.toggleColumn('year'); });
    await waitFor(() => expect(result.current.visibleColumns.year).toBe(false));

    const raw = await AsyncStorage.getItem(STORAGE_KEY_A);
    const stored = JSON.parse(raw!);
    expect(stored.year).toBe(false);
  });

  it('year and contentType are always true even when AsyncStorage has stored false for them (FR-019b / TR37)', async () => {
    const stored = JSON.stringify({ year: false, contentType: false });
    await AsyncStorage.setItem(STORAGE_KEY_A, stored);

    const { result } = renderHook(() => useColumnVisibility(USER_A));
    await waitFor(() => expect(result.current.isLoaded).toBe(true));
    expect(result.current.visibleColumns.year).toBe(true);
    expect(result.current.visibleColumns.contentType).toBe(true);
  });

  it('scopes preferences to userId — two users get independent preferences', async () => {
    const keyA = `@mcm:columnVisibility:${USER_A}`;
    const keyB = `@mcm:columnVisibility:${USER_B}`;
    // year is forced true (FR-019b); scope the test on a toggleable column.
    await AsyncStorage.setItem(keyA, JSON.stringify({ language: false }));
    await AsyncStorage.setItem(keyB, JSON.stringify({ language: true }));

    const { result: rA } = renderHook(() => useColumnVisibility(USER_A));
    const { result: rB } = renderHook(() => useColumnVisibility(USER_B));
    await waitFor(() => expect(rA.current.isLoaded).toBe(true));
    await waitFor(() => expect(rB.current.isLoaded).toBe(true));

    expect(rA.current.visibleColumns.language).toBe(false);
    expect(rB.current.visibleColumns.language).toBe(true);
  });
});
