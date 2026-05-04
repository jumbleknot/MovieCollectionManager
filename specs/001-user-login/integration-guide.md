# Integration Guide — User Login Feature

## Architecture Overview

```
React Native App
   └─ Expo Router (frontend/mcm-app/src/app/)
         ├─ (auth)/login.tsx   ──> useKeycloakAuth + useLogin
         ├─ (auth)/register.tsx ──> RegisterForm + useRegistration
         ├─ (app)/*  [protected by AuthGuard]
         └─ bff-api/auth/*  (API Routes — runs server-side)
               ├─ login+api.ts
               ├─ register+api.ts
               ├─ refresh+api.ts
               ├─ logout+api.ts
               ├─ user+api.ts
               ├─ verify-email+api.ts
               └─ resend-verification+api.ts
```

---

## Frontend ↔ BFF Integration

### Authentication Flow (Login)

1. User taps "Login with Keycloak" in `(auth)/login.tsx`
2. `useKeycloakAuth` creates a PKCE `AuthRequest` with `expo-auth-session`
3. `promptAsync()` opens the Keycloak hosted login page
4. After success, Keycloak redirects to the app with `?code=...`
5. `expo-auth-session` captures the response; `useKeycloakAuth` calls `onCode({ code, codeVerifier, redirectUri })`
6. `useLogin` POSTs `{ code, codeVerifier, redirectUri }` to `POST /bff-api/auth/login`
7. BFF returns 200 + sets HTTP-only cookies + `X-Session-Id` header
8. `storeTokens(sessionId)` saves sessionId to expo-secure-store for fallback
9. `useAuth` context updates `isAuthenticated = true`, `user = <profile>`

### Registration Flow

1. User taps "Create Account" → navigated to `(auth)/register.tsx`
2. `RegisterForm` renders fields with real-time `validators.ts` validation
3. `useRegistration` POSTs form data to `POST /bff-api/auth/register`
4. BFF creates user in Keycloak, assigns `mc-user` role, sends verification email
5. On 201 success, screen transitions to `EmailVerificationScreen`
6. User clicks email link → `GET /bff-api/auth/verify-email?token=...` → Keycloak verifies

### Token Refresh

- `api-client.ts` axios instance has a response interceptor
- On 401, calls `silentRefresh()` from `token-refresh.ts`
- `silentRefresh()` POSTs to `POST /bff-api/auth/refresh`
- On success, retries the original request
- On failure, clears stored tokens; auth context sets `isAuthenticated = false`

### Logout

1. User opens profile screen, taps logout button
2. `LogoutConfirmationDialog` shown
3. On confirm: `useLogout.logout()` called
4. `useLogout` POSTs to `POST /bff-api/auth/logout` (best-effort)
5. `auth.logout()` from `useAuth` context:
   - Clears expo-secure-store via `clearTokens()`
   - Sets `isAuthenticated = false`, `user = null`
   - Navigates to `/(auth)/login`

---

## BFF ↔ Keycloak Integration

### Client Credentials

The BFF uses client credentials for Admin API calls. Configured via environment variables:

```env
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_REALM=jumbleknot
KEYCLOAK_CLIENT_ID=movie-collection-manager
KEYCLOAK_CLIENT_SECRET=<secret>
KEYCLOAK_ADMIN_CLIENT_ID=admin-cli
KEYCLOAK_ADMIN_CLIENT_SECRET=<admin-secret>
```

### Keycloak Operations (`bff-server/keycloak.ts`)

| Function | Keycloak Endpoint | Used By |
|----------|-------------------|---------|
| `exchangeCodeForTokens` | `POST /token` (PKCE) | `/login` |
| `refreshTokens` | `POST /token` (refresh_token) | `/refresh` |
| `revokeToken` | `POST /token/revoke` | `/logout` |
| `createUser` | Admin `POST /users` | `/register` |
| `assignMcUserRole` | Admin `POST /users/{id}/role-mappings/clients/{clientId}` | `/register` |
| `sendVerificationEmail` | Admin `PUT /users/{id}/send-verify-email` | `/register`, `/resend-verification` |
| `getUserById` | Admin `GET /users/{id}` | `/login`, `/user` |

### Token Validation (`bff-server/token-service.ts`)

1. Decode JWT without verification → extract `kid`
2. Fetch Keycloak JWKS: `GET /.well-known/jwks.json`
3. Find matching key by `kid`
4. Verify signature using RS256
5. Validate claims: `iss`, `aud`, `exp`
6. Validate `at_hash` (ID token must match access token hash)
7. Extract roles from `resource_access["movie-collection-manager"].roles`

---

## Session Management

### Session Lifecycle

```
Login → createSession(userId, sessionId) → Redis: session:{id} { userId, createdAt, lastActivity }
                                         → Redis: user_sessions:{userId} [sessionId]

Request → getValidSession(sessionId)
        → validateSessionTimeout() — idle 30 min, absolute 24 h
        → touchSession(sessionId) — update lastActivity

Logout → terminateSession(sessionId) → delete Redis key + remove from user_sessions set
       → revokeToken(refreshToken) → Keycloak revocation
```

### Concurrent Session Enforcement

- On login, `getUserSessionCount(userId)` checked
- If count ≥ 10: oldest inactive session evicted via `terminateSession()`
- New session created after eviction

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `EXPO_PUBLIC_KEYCLOAK_URL` | ✓ | Keycloak base URL (public) |
| `EXPO_PUBLIC_KEYCLOAK_REALM` | ✓ | Keycloak realm name |
| `EXPO_PUBLIC_KEYCLOAK_CLIENT_ID` | ✓ | Client ID |
| `EXPO_PUBLIC_APP_SCHEME` | ✓ | App URL scheme (`mcm-app`) |
| `EXPO_PUBLIC_REDIRECT_URI` | ✓ | OAuth redirect URI |
| `KEYCLOAK_CLIENT_SECRET` | ✓ | Client secret (server-side) |
| `KEYCLOAK_ADMIN_CLIENT_ID` | ✓ | Admin CLI client |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | ✓ | Admin CLI secret |
| `REDIS_URL` | ✓ | Redis connection string |

See `frontend/mcm-app/.env.example` for defaults.

---

## Running Locally

1. Start Keycloak + Redis via Docker Compose:
   ```sh
   docker compose -f infrastructure-as-code/docker/keycloak/compose.yaml up -d
   ```
2. Copy `frontend/mcm-app/.env.example` → `.env.local`, fill secrets
3. Install dependencies:
   ```sh
   cd frontend/mcm-app && npm install
   ```
4. Start Expo dev server:
   ```sh
   npx expo start
   ```
5. Run unit tests:
   ```sh
   npm test
   ```
6. Run E2E (Android emulator required):
   ```sh
   npx detox build --configuration android.emu.debug
   npx detox test --configuration android.emu.debug tests/e2e/
   ```

---

## Auth Guards & Route Protection

All routes under `(app)/` are wrapped with `<AuthGuard>` which:
1. Checks `useAuth().isAuthenticated`
2. Shows `LoadingIndicator` while auth resolves
3. Redirects to `/(auth)/login` if unauthenticated
4. Renders children if authenticated

Use `<ProtectedRoute requiredRole="mc-admin">` for admin-only routes.
