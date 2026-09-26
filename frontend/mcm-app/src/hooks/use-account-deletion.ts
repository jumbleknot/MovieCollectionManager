/**
 * Starting an account deletion, on either platform (feature 076 — FR-005, research R10).
 *
 * TWO MECHANISMS, ONE GUARANTEE. Both send the user to the identity provider for a fresh
 * authentication and neither destroys anything by itself — the deletion happens server-side only
 * after the returned proof passes its checks.
 *
 *   WEB: the BFF builds the authorization request, holds the PKCE verifier server-side, and
 *   receives the callback itself. The browser only ever sees a URL.
 *
 *   NATIVE: the BFF cannot redirect a native app — the constitution says so plainly, and the
 *   `mcm-app://` deep link is intercepted by Expo Router before expo-auth-session sees it. So
 *   the device runs the flow and mints the verifier, and posts the result back. The BFF still
 *   mints and parks the `state`, so the CSRF binding and the single-use property are unchanged.
 *
 * `prompt=login` and `max_age=0` are sent on BOTH paths. T001 measured that max_age=0 re-prompts
 * even when the SSO session is live and would otherwise be reused; a native path that dropped it
 * would silently reuse the session and the re-authentication would buy nothing.
 */
import { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import * as AuthSession from 'expo-auth-session';

import { apiClient } from '@/utils/api-client';
import { keycloakConfig } from '@/config/keycloak';

const CHALLENGE = '/bff-api/account/delete-challenge';
const COMPLETE = '/bff-api/account/delete';

const DISCOVERY: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: `${keycloakConfig.issuer}/protocol/openid-connect/auth`,
  tokenEndpoint: `${keycloakConfig.issuer}/protocol/openid-connect/token`,
};

/** `mcm-app://native-auth-callback` is the LOGIN callback; deletion gets its own. */
const NATIVE_REDIRECT_URI = 'mcm-app://account-delete-callback';

export interface AccountDeletionOutcome {
  /** Native only. Web navigates away instead, so it never resolves to `true`. */
  deleted: boolean;
}

export interface UseAccountDeletionReturn {
  busy: boolean;
  start: () => Promise<AccountDeletionOutcome>;
}

export function useAccountDeletion(): UseAccountDeletionReturn {
  const [busy, setBusy] = useState(false);

  const start = useCallback(async (): Promise<AccountDeletionOutcome> => {
    setBusy(true);
    try {
      if (Platform.OS === 'web') {
        const res = await apiClient.post<{ authorizationUrl: string }>(CHALLENGE, {});
        // A full page navigation, not a fetch: an interactive sign-in must happen in the user's
        // own browser. The callback lands on the BFF, which completes the deletion.
        if (typeof window !== 'undefined') window.location.assign(res.data.authorizationUrl);
        return { deleted: false };
      }

      const challenge = await apiClient.post<{
        state: string;
        authorizationParams: { scope: string; prompt: string; max_age: string };
      }>(CHALLENGE, { platform: 'native' });

      const request = new AuthSession.AuthRequest({
        clientId: keycloakConfig.clientId,
        redirectUri: NATIVE_REDIRECT_URI,
        responseType: AuthSession.ResponseType.Code,
        scopes: [challenge.data.authorizationParams.scope],
        codeChallengeMethod: AuthSession.CodeChallengeMethod.S256,
        // The state the BFF parked — not one expo-auth-session invents, or the callback could
        // never be matched to the request that started it.
        state: challenge.data.state,
        prompt: AuthSession.Prompt.Login,
        extraParams: { max_age: challenge.data.authorizationParams.max_age },
      });

      const result = await request.promptAsync(DISCOVERY);
      if (result.type !== 'success' || !result.params['code']) return { deleted: false };

      const completion = await apiClient.post<{ deleted: boolean }>(COMPLETE, {
        code: result.params['code'],
        state: challenge.data.state,
        // The verifier never left the device until now, and the BFF only reads it because the
        // record it parked is marked native.
        codeVerifier: request.codeVerifier,
        redirectUri: NATIVE_REDIRECT_URI,
      });

      return { deleted: completion.data.deleted === true };
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, start };
}
