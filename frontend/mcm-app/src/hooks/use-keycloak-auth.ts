/**
 * useKeycloakAuth hook (T-061)
 * Configures expo-auth-session for PKCE Authorization Code Flow with Keycloak.
 * Exposes promptAsync() to initiate the Keycloak hosted login redirect.
 */

import { useEffect } from 'react';
import * as AuthSession from 'expo-auth-session';
import { KEYCLOAK_DISCOVERY_ENDPOINT, keycloakConfig } from '@/config/keycloak';
import type { LoginRequest } from '@/types/auth';

export interface KeycloakAuthResult {
  /** Initiates the Keycloak hosted login page via system browser / WebView */
  promptAsync: () => Promise<void>;
  isLoading: boolean;
  error: string | null;
}

interface UseKeycloakAuthOptions {
  /** Called with {code, codeVerifier, redirectUri} when auth code is obtained */
  onCode: (loginRequest: LoginRequest) => Promise<void>;
  /** Called when the user cancels or the flow is dismissed */
  onCancel?: () => void;
  /** Called on auth error */
  onError?: (message: string) => void;
}

export function useKeycloakAuth({
  onCode,
  onCancel,
  onError,
}: UseKeycloakAuthOptions): KeycloakAuthResult {
  const discovery = AuthSession.useAutoDiscovery(KEYCLOAK_DISCOVERY_ENDPOINT);

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: keycloakConfig.clientId,
      redirectUri: keycloakConfig.redirectUri,
      scopes: ['openid', 'profile', 'email'],
      codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
      responseType: AuthSession.ResponseType.Code,
    },
    discovery,
  );

  useEffect(() => {
    if (!response) return;

    if (response.type === 'success') {
      const { code } = response.params;
      const codeVerifier = request?.codeVerifier;
      const redirectUri = keycloakConfig.redirectUri;

      if (!code || !codeVerifier) {
        onError?.('Missing authorization code or code verifier.');
        return;
      }

      onCode({ code, codeVerifier, redirectUri }).catch((err: unknown) => {
        onError?.(err instanceof Error ? err.message : 'Login failed.');
      });
    } else if (response.type === 'cancel' || response.type === 'dismiss') {
      onCancel?.();
    } else if (response.type === 'error') {
      onError?.(response.error?.message ?? 'Authentication failed.');
    }
  }, [response]);  // eslint-disable-line react-hooks/exhaustive-deps

  async function handlePromptAsync(): Promise<void> {
    if (!request) return;
    await promptAsync();
  }

  return {
    promptAsync: handlePromptAsync,
    isLoading: !request && !discovery,
    error: null,
  };
}
