/**
 * useKeycloakAuth hook (T-061)
 * Configures expo-auth-session for PKCE Authorization Code Flow with Keycloak.
 * Exposes promptAsync() to initiate the Keycloak hosted login redirect.
 */

import { useEffect } from 'react';
import * as AuthSession from 'expo-auth-session';
import { keycloakConfig } from '@/config/keycloak';
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

// Static discovery document — avoids a client-side fetch to Keycloak
// on mount that fails with CORS "failed to fetch" in browser environments.
// Keycloak's endpoint structure is standardised and does not change.
const DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: `${keycloakConfig.issuer}/protocol/openid-connect/auth`,
  tokenEndpoint: `${keycloakConfig.issuer}/protocol/openid-connect/token`,
  revocationEndpoint: `${keycloakConfig.issuer}/protocol/openid-connect/revoke`,
  endSessionEndpoint: `${keycloakConfig.issuer}/protocol/openid-connect/logout`,
  userInfoEndpoint: `${keycloakConfig.issuer}/protocol/openid-connect/userinfo`,
};

export function useKeycloakAuth({
  onCode,
  onCancel,
  onError,
}: UseKeycloakAuthOptions): KeycloakAuthResult {
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: keycloakConfig.clientId,
      redirectUri: keycloakConfig.redirectUri,
      scopes: ['openid', 'profile', 'email'],
      codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
      responseType: AuthSession.ResponseType.Code,
    },
    DISCOVERY,
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
    if (!request) {
      onError?.('Authentication service is not available. Please ensure Keycloak is running.');
      return;
    }
    try {
      await promptAsync();
    } catch (err) {
      onError?.(err instanceof Error ? err.message : 'Failed to connect to authentication service.');
    }
  }

  return {
    promptAsync: handlePromptAsync,
    isLoading: !request,
    error: null,
  };
}
