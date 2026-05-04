/**
 * Unit tests for useRegistration hook (T-053)
 */

import { renderHook, act } from '@testing-library/react-native';
import axios from 'axios';
import { useRegistration } from '@/hooks/use-registration';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const validRequest = {
  username: 'testuser',
  email: 'test@example.com',
  firstName: 'Test',
  lastName: 'User',
  password: 'SecurePass1!extra',
};

describe('useRegistration', () => {
  beforeEach(() => jest.clearAllMocks());

  it('starts with default state', () => {
    const { result } = renderHook(() => useRegistration());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.isSuccess).toBe(false);
    expect(result.current.registeredEmail).toBeNull();
  });

  it('sets isLoading during registration', async () => {
    let resolveApi!: () => void;
    mockedAxios.post.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveApi = () => resolve({ data: { success: true } });
      }),
    );

    const { result } = renderHook(() => useRegistration());

    act(() => {
      result.current.register(validRequest);
    });

    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      resolveApi();
    });
  });

  it('sets isSuccess and registeredEmail on success', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { success: true, message: 'Account created.', userId: 'user-123' },
    });

    const { result } = renderHook(() => useRegistration());

    await act(async () => {
      await result.current.register(validRequest);
    });

    expect(result.current.isSuccess).toBe(true);
    expect(result.current.registeredEmail).toBe('test@example.com');
    expect(result.current.error).toBeNull();
  });

  it('sets error on failure', async () => {
    mockedAxios.post.mockRejectedValueOnce({
      response: {
        data: { code: 'DUPLICATE_EMAIL', error: 'An account with that email already exists.' },
        status: 409,
      },
    });

    const { result } = renderHook(() => useRegistration());

    await act(async () => {
      await result.current.register(validRequest);
    });

    expect(result.current.isSuccess).toBe(false);
    expect(result.current.error).toContain('email');
    expect(result.current.isLoading).toBe(false);
  });

  it('reset clears state', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { success: true, message: 'Account created.', userId: 'user-123' },
    });

    const { result } = renderHook(() => useRegistration());

    await act(async () => {
      await result.current.register(validRequest);
    });

    act(() => {
      result.current.reset();
    });

    expect(result.current.isSuccess).toBe(false);
    expect(result.current.registeredEmail).toBeNull();
  });
});
