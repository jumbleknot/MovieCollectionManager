# Tasks: User Login & Registration

**Feature Branch**: `001-user-login`  
**Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md)  
**Input**: Design documents from `/specs/001-user-login/`  
**Prerequisites**: plan.md (complete), spec.md (complete with 4 user stories)

**Output Location**: `specs/001-user-login/tasks.md`

**Test Coverage Target**: 70% (unit + integration + E2E)  
**Time Estimate**: Phase 1 (2 days), Phase 2 (3 days), Phase 3-6 (8 days), Phase 7 (2 days) = ~15 days total

---

## Format: `[ID] [P?] [Story] Description`

- **[ID]**: T-NNN format (sequential)
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: User story label (US1, US2, US3, US4) - only for user story phases
- File paths use kebab-case naming convention throughout

## Path Reference

- **Frontend Client**: `frontend/mcm-app/src/`
- **BFF API Routes**: `frontend/mcm-app/src/app/bff-api/` (source files only; no unit-tests subdirectories)
- **BFF Server**: `frontend/mcm-app/src/bff-server/`
- **Components**: `frontend/mcm-app/src/components/`
- **Screens**: `frontend/mcm-app/src/screens/`
- **Tests**: 
  - Unit tests for BFF routes: `frontend/mcm-app/tests/app/bff-api/` (mirrors src/app structure, test files match route file names with `.test.ts` extension)
  - Unit tests for other layers: `frontend/mcm-app/src/**/**/unit-tests/` (co-located)
  - Integration/E2E tests: `frontend/mcm-app/tests/integration/` and `frontend/mcm-app/tests/e2e/`

---

## Phase 0: Research & Clarification (COMPLETED ✅)

**Status**: All clarifications resolved per plan.md

✅ JWT token expiration and automatic refresh strategy defined  
✅ Error messaging strategy for security and UX defined  
✅ User profile attributes defined (username, email, first/last name, roles, status)  
✅ Password policy and email verification requirements finalized  
✅ Concurrent session management strategy finalized (max 10 per user)  
✅ Rate limiting strategy per endpoint  
✅ Keycloak integration pattern finalized (OAuth2/OIDC Authorization Code Flow)  
✅ Session storage strategy (secure HTTP-only cookies with expo-secure-store fallback)  
✅ Email resend-verification flow defined (POST /bff-api/auth/resend-verification, rate limited 3/email/hour)  
✅ Session timeout defined (30-minute idle timeout, 24-hour absolute timeout)  

---

## Phase 1: Setup & Infrastructure

**Purpose**: Project structure and Keycloak configuration

### Checkpoint Requirements
- [ ] ✅ Keycloak realm `jumbleknot` client `movie-collection-manager` configured with roles `mc-admin` and `mc-user`
- [ ] ✅ Redis cache configured and accessible from BFF
- [ ] ✅ SMTP configuration in Keycloak for email verification
- [ ] ✅ All project dependencies installed

### Tasks

- [ ] T-001 Create BFF API routes structure for auth endpoints in `frontend/mcm-app/src/app/bff-api/auth/`
- [ ] T-002 [P] Create BFF server utility modules structure in `frontend/mcm-app/src/bff-server/`
- [ ] T-003 [P] Create frontend components structure in `frontend/mcm-app/src/components/`
- [ ] T-004 [P] Create frontend screens structure in `frontend/mcm-app/src/screens/auth/`
- [ ] T-005 Create frontend utilities structure in `frontend/mcm-app/src/utils/`
- [ ] T-006 Create frontend hooks structure in `frontend/mcm-app/src/hooks/`
- [ ] T-007 [P] Create test directories structure: 
  - `frontend/mcm-app/src/{bff-server,utils,hooks,components}/unit-tests/` (for co-located unit tests)
  - `frontend/mcm-app/tests/app/bff-api/auth/` (for BFF route tests - mirrors src/app structure, ensures no routes created by test files)
  - `frontend/mcm-app/tests/integration/` (for integration tests)
  - `frontend/mcm-app/tests/e2e/` (for E2E tests)
- [ ] T-008 Create TypeScript interfaces and types for auth domain in `frontend/mcm-app/src/types/auth.ts`
- [ ] T-009 Configure Keycloak realm `jumbleknot` with client `movie-collection-manager` (server-side setup)
- [ ] T-009a [P] Configure Expo redirect URI in Keycloak client `movie-collection-manager`: register the app redirect URI (e.g., `exp://localhost:8081/--/bff-api/auth/callback` for dev; custom scheme for production) as an allowed redirect URI in Keycloak client settings; document URI scheme in `frontend/mcm-app/src/config/keycloak.ts` (T-019)
- [ ] T-010 [P] Configure Keycloak client roles: `mc-admin` and `mc-user` (server-side setup)
- [ ] T-011 [P] Configure Keycloak SMTP for email verification (server-side setup)
- [ ] T-012 Configure Keycloak password policy: min 12 chars with uppercase, lowercase, digit, special char (server-side setup)
- [ ] T-013 Setup Keycloak email verification timeout to 24 hours (server-side setup)
- [ ] T-014 [P] Setup Redis connection configuration in `frontend/mcm-app/.env.local` for BFF caching
- [ ] T-015 [P] Install and configure Jest for unit testing in `frontend/mcm-app/`
- [ ] T-016 [P] Install and configure React Testing Library for component testing
- [ ] T-017 [P] Install and configure Detox for E2E testing
- [ ] T-018 Create BFF error handling middleware in `frontend/mcm-app/src/bff-server/error-handler.ts`
- [ ] T-019 [P] Create environment configuration loader in `frontend/mcm-app/src/config/`: create `keycloak.ts` (realm URL, client ID, redirect URI, discovery endpoint) and `env.ts` (environment variable loader); keycloak config is the `expo-auth-session` discovery/AuthRequest configuration source
- [ ] T-020 Document setup instructions in `specs/001-user-login/quickstart.md` (setup verification)

**Checkpoint**: Infrastructure ready - all directories created, Keycloak configured, dependencies installed

---

## Phase 2: Foundational Layer (BLOCKING PREREQUISITES)

**Purpose**: Core auth services and middleware that block all user stories

⚠️ **CRITICAL**: No user story work can begin until this phase is 100% complete

### Checkpoint Requirements
- [ ] ✅ BFF Keycloak integration tested and working
- [ ] ✅ JWT validation middleware working
- [ ] ✅ Role-based access control middleware working
- [ ] ✅ Rate limiting middleware working
- [ ] ✅ Session storage (secure cookies) configured
- [ ] ✅ All foundational services tested (70% coverage target)

### Keycloak Integration Services

- [ ] T-021 Implement Keycloak client service in `frontend/mcm-app/src/bff-server/keycloak.ts`: OAuth2 configuration, token exchange, user creation, email verification
- [ ] T-022 [P] Implement JWT token service in `frontend/mcm-app/src/bff-server/token-service.ts`: token parsing, expiration detection, refresh logic, validation
- [ ] T-023 [P] Implement email service in `frontend/mcm-app/src/bff-server/email-service.ts`: send verification emails via Keycloak, resend capability
- [ ] T-024 [P] Implement Redis cache service in `frontend/mcm-app/src/bff-server/cache-service.ts`: session state caching (10-min TTL), user profile caching (5-min TTL), rate-limit counters

### BFF Middleware Layer

- [ ] T-025 Implement JWT validation middleware in `frontend/mcm-app/src/bff-server/auth.ts`: extract JWT from cookies/headers, validate signature, check expiration
- [ ] T-026 [P] Implement role-based access control middleware in `frontend/mcm-app/src/bff-server/role-check.ts`: verify user has `mc-user` or `mc-admin` role
- [ ] T-027 [P] Implement rate limiting middleware in `frontend/mcm-app/src/bff-server/rate-limiter.ts`: per-endpoint limits (register 10/email/day, login 5/IP/minute, refresh auto-throttle, verify-email 1/token, resend 3/email/hour)
- [ ] T-028 [P] Implement session management middleware in `frontend/mcm-app/src/bff-server/session-manager.ts`: track concurrent sessions (max 10), manage session state, enforce limits
- [ ] T-028a [P] Implement session timeout middleware in `frontend/mcm-app/src/bff-server/session-timeout.ts`: enforce 30-minute idle timeout and 24-hour absolute timeout, redirect to login on expiration
- [ ] T-028b [P] Implement client-side session timeout hook in `frontend/mcm-app/src/hooks/use-session-timeout.ts`: accept `onTimeout: () => void` callback; track user activity events (touch, keypress, scroll); reset idle timer on activity; call `onTimeout` after 30-minute idle; call `onTimeout` at 24-hour absolute timeout from session creation time (wire `onTimeout` to `useAuth` logout action in T-064/T-103)

### Frontend Session Management

- [ ] T-029 Implement session storage utility in `frontend/mcm-app/src/utils/session-storage.ts`: secure cookie storage, expo-secure-store fallback for platforms with cookie restrictions, token management
- [ ] T-030 [P] Implement token refresh strategy in `frontend/mcm-app/src/utils/token-refresh.ts`: core silent background refresh logic, auto-retry on 401, fallback to re-login, rate-limit management (used by T-068 as Axios interceptor)
- [ ] T-031 [P] Implement form validators in `frontend/mcm-app/src/utils/validators.ts`: email format, password policy (12+ chars, complexity), username (3-20 alphanumeric + underscore)

### Error Handling & Messaging

- [ ] T-032 Implement error message mapping in `frontend/mcm-app/src/utils/errors.ts`: security-safe messages for each error type (weak password, duplicate user, invalid credentials, Keycloak unavailable, token expired, account locked, etc.)
- [ ] T-033 [P] Create error types definitions in `frontend/mcm-app/src/types/errors.ts`: custom error classes and error codes

### Unit Tests for Foundational Layer (70% coverage target)

- [ ] T-034 [P] Write unit tests for Keycloak service in `frontend/mcm-app/src/bff-server/unit-tests/keycloak.test.ts`: token exchange, user creation, email verification, error cases
- [ ] T-035 [P] Write unit tests for token service in `frontend/mcm-app/src/bff-server/unit-tests/token-service.test.ts`: JWT parsing, expiration detection, validation
- [ ] T-036 [P] Write unit tests for validators in `frontend/mcm-app/src/utils/unit-tests/validators.test.ts`: password policy, email format, username validation
- [ ] T-037 [P] Write unit tests for error mapping in `frontend/mcm-app/src/utils/unit-tests/errors.test.ts`: all error type mappings
- [ ] T-038 [P] Write unit tests for session storage in `frontend/mcm-app/src/utils/unit-tests/session-storage.test.ts`: cookie storage, expo-secure-store fallback logic (additional logout cleanup scenarios added by T-110)
- [ ] T-039 [P] Write unit tests for token refresh strategy in `frontend/mcm-app/src/utils/unit-tests/token-refresh.test.ts`: background refresh, retry logic, fallback to login
- [ ] T-040 [P] Write unit tests for rate-limiter in `frontend/mcm-app/src/bff-server/unit-tests/rate-limiter.test.ts`: per-endpoint limits, counter expiration
- [ ] T-040a [P] Write unit tests for session-timeout in `frontend/mcm-app/src/bff-server/unit-tests/session-timeout.test.ts`: 30-minute idle timeout expiration, 24-hour absolute timeout expiration, redirect to login, session preservation across tab/device boundaries
- [ ] T-040b [P] Write unit tests for use-session-timeout hook in `frontend/mcm-app/src/hooks/unit-tests/use-session-timeout.test.ts`: activity event tracking, idle timer reset on activity, idle timeout trigger (mock timers), absolute timeout trigger, logout + redirect on expiration

**Checkpoint**: Foundational layer complete with 70% test coverage - ALL user stories can now start in parallel

---

## Phase 3: User Story 1 - New User Self-Registration (Priority: P1) 🎯 MVP

**Goal**: Enable new users to create an account with password validation and email verification

**Independent Test**: Visit login screen, click "Create Account", enter registration details (valid per password policy), verify account created in Keycloak with `mc-user` role, receive verification email, click verification link within 24 hours, account fully activated, can then login (see US2)

### User Story 1 Requirements Met
- FR-002: Self-registration flow
- FR-004: Create user in Keycloak with `mc-user` role
- FR-004a: Password validation (12+ chars, complexity)
- FR-004b: Email verification required
- FR-004c: 24-hour verification link expiration
- SC-001: Registration < 2 minutes, email within 5 minutes, activation within 24 hours
- Edge cases: Invalid input, weak password, duplicate username, email verification pending/expired

### Frontend Components for US1

- [ ] T-041 [P] [US1] Create login screen component in `frontend/mcm-app/src/screens/auth/login-screen.tsx`: landing page with login form and "Create Account" button
- [ ] T-042 [P] [US1] Create registration form component in `frontend/mcm-app/src/components/register-form.tsx`: input fields (username, email, first name, last name, password, confirm password), validation display, submit button
- [ ] T-043 [P] [US1] Create password strength indicator component in `frontend/mcm-app/src/components/password-strength-indicator.tsx`: real-time password policy feedback
- [ ] T-044 [P] [US1] Create email verification screen in `frontend/mcm-app/src/screens/auth/email-verification-screen.tsx`: display "Check your email", link to resend button, resend capability

### Frontend Logic for US1

- [ ] T-045 [US1] Create registration route in `frontend/mcm-app/src/app/(auth)/register.tsx`: orchestrate registration screen, form submission, error handling
- [ ] T-046 [US1] Implement useRegistration hook in `frontend/mcm-app/src/hooks/use-registration.ts`: form state, validation, API call to BFF /register, error handling
- [ ] T-047 [P] [US1] Implement password validator in `frontend/mcm-app/src/utils/validators.ts`: check 12+ chars, uppercase, lowercase, digit, special char (share with T-031)
- [ ] T-048 [P] [US1] Implement email validator in `frontend/mcm-app/src/utils/validators.ts`: RFC 5322 format validation (share with T-031)

### BFF API Routes for US1

- [ ] T-049 [US1] Implement BFF /register endpoint in `frontend/mcm-app/src/app/bff-api/auth/register+api.ts`:
  - Validate request (username, email, password, names)
  - Check rate limit (10/email/day)
  - Validate password policy via Keycloak
  - Create user in Keycloak realm with `mc-user` role
  - Send verification email via Keycloak
  - Cache user context in Redis (10-min TTL)
  - Return 201 Created with verification message

- [ ] T-050 [US1] Implement BFF /verify-email endpoint in `frontend/mcm-app/src/app/bff-api/auth/verify-email+api.ts`:
  - Accept verification token from email link
  - Validate token (1-use only, 24-hour expiration)
  - Call Keycloak to mark email verified
  - Update user emailVerified flag in Keycloak
  - Invalidate verification token
  - Return 200 with success message + ability to login

- [ ] T-051 [US1] Implement BFF /resend-verification endpoint in `frontend/mcm-app/src/app/bff-api/auth/resend-verification+api.ts`:
  - Accept email address
  - Check rate limit (3/email/hour)
  - Validate email exists but unverified
  - Generate new verification token in Keycloak
  - Send new verification email
  - Return 200 with confirmation

### Unit Tests for US1

- [ ] T-052 [P] [US1] Write unit tests for register form component in `frontend/mcm-app/src/components/unit-tests/register-form.test.ts`: render form, user input, validation display, submit
- [ ] T-053 [P] [US1] Write unit tests for useRegistration hook in `frontend/mcm-app/src/hooks/unit-tests/use-registration.test.ts`: form state, validation logic, API call handling
- [ ] T-054 [P] [US1] Write unit tests for BFF /register in `frontend/mcm-app/tests/app/bff-api/auth/register+api.test.ts`: valid input, weak password, duplicate user, rate limiting, Keycloak interaction
- [ ] T-055 [P] [US1] Write unit tests for BFF /verify-email in `frontend/mcm-app/tests/app/bff-api/auth/verify-email+api.test.ts`: valid token, expired token, already verified, Keycloak update
- [ ] T-056 [P] [US1] Write unit tests for BFF /resend-verification in `frontend/mcm-app/tests/app/bff-api/auth/resend-verification+api.test.ts`: valid email, rate limiting, token generation

### Integration Tests for US1

- [ ] T-057 [US1] Write integration test for registration flow in `frontend/mcm-app/tests/integration/register.test.ts`: submit registration form, verify API call, check Keycloak user created, confirm email sent (mocked Keycloak)
- [ ] T-058 [US1] Write integration test for email verification flow in `frontend/mcm-app/tests/integration/email-verification.test.ts`: click verification link, verify Keycloak email marked verified, account ready to login

### E2E Tests for US1

- [ ] T-059 [US1] Write E2E test for complete registration in `frontend/mcm-app/tests/e2e/auth.e2e.ts`: navigate to register, fill form, submit, receive verification email (test environment), click link, verify activation

**Checkpoint**: User Story 1 complete and testable independently - new users can register with email verification

---

## Phase 4: User Story 2 - Existing User Login (Priority: P1)

**Goal**: Enable existing users to authenticate via Keycloak Authorization Code Flow with PKCE and receive a JWT token

**Independent Test**: Press "Login" button, verify redirect to Keycloak hosted login, enter valid credentials, verify redirect back to app with authorization code, verify BFF exchanges code for JWT, verify JWT cookie present, verify navigation to home screen; auth failure rejected with error; Keycloak unavailability handled gracefully

### User Story 2 Requirements Met
- FR-001: Login screen as initial application screen
- FR-003: Validate credentials against Keycloak (via Auth Code Flow — Keycloak hosts login)
- FR-005: Store JWT token in session (via BFF code exchange)
- FR-005a: JWT auto-refresh capability
- FR-005b: Redirect to login if refresh fails
- SC-002: Login < 5 seconds, navigate to home screen
- Edge cases: Auth failure, Keycloak unavailable, account locked, account disabled

### Frontend Components for US2

- [ ] T-060 [P] [US2] Create loading indicator component in `frontend/mcm-app/src/components/loading-indicator.tsx`: spinner during auth operations (Keycloak redirect in progress)

### Frontend Logic for US2  *(Auth Code Flow with expo-auth-session)*

- [ ] T-061 [US2] Configure `expo-auth-session` in `frontend/mcm-app/src/hooks/use-keycloak-auth.ts`: create `AuthRequest` with PKCE (S256), load discovery from Keycloak realm URL, configure `redirectUri` matching Keycloak client registration, expose `promptAsync()` to trigger redirect
- [ ] T-062 [US2] Update login route in `frontend/mcm-app/src/app/(auth)/login.tsx`: display login screen with "Login with Keycloak" primary button and a "Create Account" link (navigates to registration screen per Option A — app-side registration form); on Login press call `promptAsync()` from T-061; handle auth result (success → call BFF /login with code+codeVerifier+redirectUri; failure → display error)
- [ ] T-063 [US2] Implement useLogin hook in `frontend/mcm-app/src/hooks/use-login.ts`: receive auth code result from use-keycloak-auth, call BFF /login endpoint with `{code, codeVerifier, redirectUri}`, handle response, store session, navigate to home on success
- [ ] T-064 [P] [US2] Implement useAuth context hook in `frontend/mcm-app/src/hooks/use-auth.ts`: global auth state management, user profile state, token management, login/logout actions; provide `onTimeout` callback for T-028b wiring

### BFF API Routes for US2

- [ ] T-065 [US2] Implement BFF /login endpoint in `frontend/mcm-app/src/app/bff-api/auth/login+api.ts`:
  - Validate rate limit (5/IP/minute)
  - Validate request (code, codeVerifier, redirectUri present)
  - Exchange authorization code + codeVerifier for tokens with Keycloak (Auth Code + PKCE)
  - Validate ID token claims (iss, aud, exp, at_hash)
  - Extract user identity and roles from ID token
  - Check account status (not locked, not disabled)
  - Check session count (max 10 concurrent)
  - Remove oldest inactive session if at limit
  - Cache session state in Redis (10-min TTL)
  - Return 200 with JWT in secure HTTP-only cookie + user profile
  - Set X-Session-Id header for session tracking

- [ ] T-066 [US2] Implement BFF /refresh endpoint in `frontend/mcm-app/src/app/bff-api/auth/refresh+api.ts`:
  - Validate refresh token
  - Check rate limit (auto-throttle: 1/30s per session, max 2 retries)
  - Check Redis cache for session validity
  - Exchange refresh token with Keycloak
  - Generate new JWT + refresh token
  - Update Redis session cache
  - Return 200 with new JWT in secure cookie + expiration time

- [ ] T-067 [US2] Implement BFF /user endpoint in `frontend/mcm-app/src/app/bff-api/auth/user+api.ts`:
  - Validate JWT token + role (requires mc-user or mc-admin)
  - Check Redis cache for user profile (hit → return cached)
  - Fetch from Keycloak if cache miss
  - Cache result in Redis (5-min TTL)
  - Return 200 with user profile (id, username, email, first/last name, roles, status)

### Frontend Token Management

- [ ] T-068 [US2] Implement token refresh interceptor in `frontend/mcm-app/src/utils/token-refresh.ts`: wire T-030 refresh logic as Axios interceptor (auto-refresh on 401, retry original request, fallback to re-login on failure; depends on T-030)
- [ ] T-069 [P] [US2] Implement axios instance with JWT injection in `frontend/mcm-app/src/bff-server/api-client.ts`: automatic JWT from cookies, refresh interceptor, error handling

### Unit Tests for US2

- [ ] T-070 [P] [US2] Write unit tests for use-keycloak-auth hook in `frontend/mcm-app/src/hooks/unit-tests/use-keycloak-auth.test.ts`: AuthRequest creation, PKCE parameter generation, promptAsync call, auth result handling (success/error/cancel)
- [ ] T-071 [P] [US2] Write unit tests for useLogin hook in `frontend/mcm-app/src/hooks/unit-tests/use-login.test.ts`: code+codeVerifier+redirectUri passed to BFF, session stored on success, error scenarios
- [ ] T-072 [P] [US2] Write unit tests for BFF /login in `frontend/mcm-app/tests/app/bff-api/auth/login+api.test.ts`: valid code exchange, invalid/expired code, mismatched redirectUri, rate limiting, session management, ID token validation
- [ ] T-073 [P] [US2] Write unit tests for BFF /refresh in `frontend/mcm-app/tests/app/bff-api/auth/refresh+api.test.ts`: valid refresh token, invalid token, rate limiting, session cache
- [ ] T-074 [P] [US2] Write unit tests for BFF /user in `frontend/mcm-app/tests/app/bff-api/auth/user+api.test.ts`: valid JWT, invalid JWT, role checking, cache hit/miss
- [ ] T-075 [P] [US2] Write unit tests for useAuth hook in `frontend/mcm-app/src/hooks/unit-tests/use-auth.test.ts`: context state management, token updates, user profile updates

### Integration Tests for US2

- [ ] T-076 [US2] Write integration test for login flow in `frontend/mcm-app/tests/integration/login.test.ts`: simulate valid authorization code exchange with mocked Keycloak token endpoint, verify JWT received in cookie, session stored in Redis, user profile available
- [ ] T-077 [US2] Write integration test for token refresh in `frontend/mcm-app/tests/integration/token-refresh.test.ts`: token expiration, silent refresh triggered, new token stored, original request retried
- [ ] T-078 [US2] Write integration test for login error handling in `frontend/mcm-app/tests/integration/login-errors.test.ts`: simulate invalid/expired authorization code (Keycloak token endpoint returns error), simulate Keycloak token endpoint unavailable, simulate account locked response, verify correct error states returned to client

### E2E Tests for US2

- [ ] T-079 [US2] Write E2E test for login flow in `frontend/mcm-app/tests/e2e/auth.e2e.ts`: tap Login button, handle Keycloak hosted login page in WebView/system browser (enter valid test credentials), verify redirect back to app, verify JWT cookie present, verify navigation to home screen
- [ ] T-080 [US2] Write E2E test for failed login in `frontend/mcm-app/tests/e2e/auth.e2e.ts`: tap Login button, enter invalid credentials on Keycloak login page, verify Keycloak error shown, dismiss/return to app, verify app login screen shown with "Authentication failed" error state

**Checkpoint**: User Story 2 complete and testable independently - existing users can login and receive JWT tokens

---

## Phase 5: User Story 3 - Access Control & Navigation (Priority: P1)

**Goal**: Protect screens based on JWT authentication and role membership; display user profile

**Independent Test**: Login (per US2), navigate to profile page, verify profile information displayed (username, email, first/last name, roles, status); logout without authentication should redirect to login screen

### User Story 3 Requirements Met
- FR-006: Validate JWT token membership in mc-admin or mc-user roles
- FR-007: Restrict protected screens to authenticated users only
- FR-008: Navigation bar with Home and Profile links
- FR-009: Profile page displays username, email, first/last name, roles, account status
- SC-004: Unauthorized access blocked 100%
- SC-005: Profile loads < 2 seconds

### Frontend Components for US3

- [ ] T-081 [P] [US3] Create auth guard component in `frontend/mcm-app/src/components/auth-guard.tsx`: protect routes, check JWT + role, redirect unauthenticated users to login
- [ ] T-082 [P] [US3] Create navigation bar component in `frontend/mcm-app/src/components/navigation-bar.tsx`: display Home and Profile links, logo, navigation structure
- [ ] T-083 [P] [US3] Create profile display component in `frontend/mcm-app/src/components/profile-display.tsx`: show user info (username, email, first/last name, roles, status), formatted display
- [ ] T-084 [P] [US3] Create profile screen component in `frontend/mcm-app/src/screens/auth/profile-screen.tsx`: call useAuth hook, display profile, include logout button

### Frontend Navigation & Routing

- [ ] T-085 [US3] Update app entry point in `frontend/mcm-app/src/app/index.tsx`: navigation structure with auth guard, route groups for auth vs authenticated screens
- [ ] T-086 [US3] Create profile route in `frontend/mcm-app/src/app/(auth)/profile.tsx`: protected route with auth guard, display profile screen
- [ ] T-087 [P] [US3] Implement useAuthGuard hook in `frontend/mcm-app/src/hooks/use-auth-guard.ts`: check JWT + role, redirect logic, loading state during auth check

### Frontend Role-Based Access Control

- [ ] T-088 [US3] Implement role checker utility in `frontend/mcm-app/src/utils/role-checker.ts`: verify user has required role(s), mc-user vs mc-admin access patterns
- [ ] T-089 [P] [US3] Implement protected route component in `frontend/mcm-app/src/components/protected-route.tsx`: reusable wrapper for role-protected screens

### BFF Role Enforcement

- [ ] T-090 [US3] Add role validation to BFF /user endpoint (coordinate with T-067): require mc-user or mc-admin role
- [ ] T-091 [P] [US3] Create BFF mc-user-only endpoint guard in `frontend/mcm-app/src/bff-server/role-check.ts`: reusable middleware for mc-user role requirements (coordinate with T-026)

### Unit Tests for US3

- [ ] T-092 [P] [US3] Write unit tests for auth guard component in `frontend/mcm-app/src/components/unit-tests/auth-guard.test.ts`: render protected content, redirect unauthenticated
- [ ] T-093 [P] [US3] Write unit tests for profile display component in `frontend/mcm-app/src/components/unit-tests/profile-display.test.ts`: render user info, formatting
- [ ] T-094 [P] [US3] Write unit tests for role checker in `frontend/mcm-app/src/utils/unit-tests/role-checker.test.ts`: mc-admin vs mc-user access patterns
- [ ] T-095 [P] [US3] Write unit tests for useAuthGuard hook in `frontend/mcm-app/src/hooks/unit-tests/use-auth-guard.test.ts`: auth check, redirect logic, role validation

### Integration Tests for US3

- [ ] T-096 [US3] Write integration test for profile access in `frontend/mcm-app/tests/integration/profile-access.test.ts`: login, navigate to profile, verify user info displayed, all fields present
- [ ] T-097 [US3] Write integration test for unauthorized access in `frontend/mcm-app/tests/integration/unauthorized-access.test.ts`: access profile without JWT, redirected to login
- [ ] T-098 [US3] Write integration test for role-based access in `frontend/mcm-app/tests/integration/role-based-access.test.ts`: mc-user access to standard screens, mc-admin screens (future)

### E2E Tests for US3

- [ ] T-099 [US3] Write E2E test for profile access in `frontend/mcm-app/tests/e2e/auth.e2e.ts`: login, navigate to profile, verify all info displayed, performance < 2 seconds
- [ ] T-100 [US3] Write E2E test for unauthorized access in `frontend/mcm-app/tests/e2e/auth.e2e.ts`: try accessing profile without login, redirected to login

**Checkpoint**: User Story 3 complete and testable independently - protected screens accessible only to authenticated users with valid roles

---

## Phase 6: User Story 4 - Logout & Session Termination (Priority: P2)

**Goal**: Enable users to end their sessions safely and terminate JWT tokens

**Independent Test**: Login, navigate to profile, click logout, verify redirected to login screen, attempt to access profile screen redirects to login, other device sessions unaffected

### User Story 4 Requirements Met
- FR-010: Logout option on Profile page
- FR-011: Terminate session and clear JWT token
- FR-012: Navigate to login screen after logout
- FR-012a: Multiple concurrent sessions per user
- FR-012b: Logout from one device doesn't affect other devices
- FR-012c: Independent JWT tokens per session
- SC-006: Logout effective 100% - user cannot access protected screens
- SC-010: Logout isolation - other sessions remain active

### Frontend Components for US4

- [ ] T-101 [P] [US4] Add logout button to profile display component in `frontend/mcm-app/src/components/profile-display.tsx`: logout button with confirmation dialog
- [ ] T-102 [P] [US4] Create logout confirmation dialog component in `frontend/mcm-app/src/components/logout-confirmation-dialog.tsx`: confirm logout action before proceeding

### Frontend Logic for US4

- [ ] T-103 [US4] Add logout action to useAuth context hook (coordinate with T-064): update auth state to logged-out, clear session storage, navigate to login
- [ ] T-104 [US4] Implement useLogout hook in `frontend/mcm-app/src/hooks/use-logout.ts`: call BFF /logout endpoint, handle errors, then invoke T-103's logout action to clear auth state (depends on T-103)
- [ ] T-105 [P] [US4] Implement session storage cleanup in `frontend/mcm-app/src/utils/session-storage.ts`: clear JWT tokens, clear refresh tokens, remove session cookies (coordinate with T-029)

### BFF API Routes for US4

- [ ] T-106 [US4] Implement BFF /logout endpoint in `frontend/mcm-app/src/app/bff-api/auth/logout+api.ts`:
  - Validate JWT token
  - Extract session ID from request (X-Session-Id header)
  - Invalidate session in Redis
  - Notify Keycloak (revoke refresh token)
  - Clear secure cookie on client (Set-Cookie with max-age=0)
  - Return 200 Success message
  - Do NOT invalidate other sessions for same user

### Unit Tests for US4

- [ ] T-107 [P] [US4] Write unit tests for logout confirmation dialog in `frontend/mcm-app/src/components/unit-tests/logout-confirmation-dialog.test.ts`: render, confirm, cancel
- [ ] T-108 [P] [US4] Write unit tests for useLogout hook in `frontend/mcm-app/src/hooks/unit-tests/use-logout.test.ts`: logout action, API call, session cleanup
- [ ] T-109 [P] [US4] Write unit tests for BFF /logout in `frontend/mcm-app/tests/app/bff-api/auth/logout+api.test.ts`: valid JWT, session invalidation, Keycloak revocation, cookie clearing
- [ ] T-110 [P] [US4] Write unit tests for session cleanup in `frontend/mcm-app/src/utils/unit-tests/session-storage.test.ts`: add logout cleanup scenarios (clear tokens, cookies, storage) to existing test file (extends T-038)

### Integration Tests for US4

- [ ] T-111 [US4] Write integration test for logout flow in `frontend/mcm-app/tests/integration/logout.test.ts`: logout call, session cleared, unable to access protected screens
- [ ] T-112 [US4] Write integration test for multi-device session independence in `frontend/mcm-app/tests/integration/concurrent-sessions.test.ts`: login on 2 devices (simulated), logout from device 1, verify device 2 still logged in

### E2E Tests for US4

- [ ] T-113 [US4] Write E2E test for logout in `frontend/mcm-app/tests/e2e/auth.e2e.ts`: login, navigate to profile, click logout, verify redirected to login, profile inaccessible
- [ ] T-114 [US4] Write E2E test for concurrent session independence in `frontend/mcm-app/tests/e2e/concurrent-sessions.e2e.ts`: simulate 2 devices, logout from one, verify other unaffected (if feasible in E2E)

**Checkpoint**: User Story 4 complete and testable independently - users can logout with session termination and multi-device session isolation

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final refinements, documentation, performance optimization, and comprehensive testing

### Documentation & Guides

- [ ] T-115 [P] Update quickstart.md with complete setup instructions in `specs/001-user-login/quickstart.md`: environment setup, Keycloak configuration, running tests, local development workflow
- [ ] T-116 [P] Create API contract documentation in `specs/001-user-login/contracts/auth-api.md`: all 6 endpoints, request/response formats, error codes, rate limits, examples
- [ ] T-117 [P] Create data model documentation in `specs/001-user-login/data-model.md`: User, JWT, ClientRole entities, Keycloak integration details
- [ ] T-118 [P] Create integration guide in `specs/001-user-login/integration-guide.md`: how frontend integrates with BFF, how BFF integrates with Keycloak, session management flow

### Cross-Cutting Tests & Coverage

- [ ] T-119 Run all unit tests with coverage report: ensure 70%+ coverage across all layers
- [ ] T-120 [P] Run all integration tests to verify flows work end-to-end
- [ ] T-121 [P] Run E2E tests with Detox across web and mobile platforms (if available)
- [ ] T-122 Verify error message coverage: all specified error scenarios return correct messages
- [ ] T-123 [P] Load testing: validate performance targets (login < 5s, profile < 2s, verify < 10s)

### Security Hardening

- [ ] T-124 [P] Verify secure cookie configuration: HTTP-only, Secure flag, SameSite=Strict
- [ ] T-125 [P] Verify password policy enforcement: 12+ chars, complexity validation tested
- [ ] T-126 [P] Verify CSRF protection: appropriate headers and token validation
- [ ] T-127 [P] Verify rate limiting effectiveness: attempt to exceed limits, verify 429 response
- [ ] T-128 [P] Verify JWT token validation: invalid signatures, expired tokens, token claims validation
- [ ] T-129 Verify session isolation: concurrent sessions truly independent, logout doesn't affect other sessions

### Session Timeout Validation (SC-011)

- [ ] T-149 Write integration test for session idle timeout in `frontend/mcm-app/tests/integration/session-timeout.test.ts`: simulate 30-minute idle (mock timers), verify session terminated, user redirected to login with correct "due to inactivity" message; simulate 24-hour absolute timeout, verify redirect with correct message
- [ ] T-150 [P] Write E2E test for session idle timeout in `frontend/mcm-app/tests/e2e/session-timeout.e2e.ts`: login, fast-forward idle timer via test override, verify automatic redirect to login screen

### Frontend Refinements

- [ ] T-130 [P] Optimize component re-renders: verify no unnecessary re-renders during auth flow
- [ ] T-131 [P] Add loading states: display spinners during API calls, form submission
- [ ] T-132 [P] Add error display improvements: toast notifications, form-level errors, inline validation
- [ ] T-133 [P] Keyboard navigation improvements: tab through form fields, enter to submit, escape to cancel
- [ ] T-134 [P] Accessibility improvements: ARIA labels, semantic HTML, screen reader testing

### BFF Refinements

- [ ] T-135 [P] Add request logging: log auth operations for debugging and security audit
- [ ] T-136 [P] Add metrics/monitoring: track login success rate, token refresh rates, error rates
- [ ] T-137 [P] Optimize Keycloak interactions: cache client token, batch operations where possible
- [ ] T-138 [P] Add circuit breaker pattern: graceful handling if Keycloak becomes unavailable

### Cross-Platform Testing

- [ ] T-139 [P] Test registration flow on web platform
- [ ] T-140 [P] Test registration flow on mobile (Android) platform
- [ ] T-141 [P] Test login flow on web platform
- [ ] T-142 [P] Test login flow on mobile (Android) platform
- [ ] T-143 [P] Verify AsyncStorage fallback works on platforms with cookie restrictions

### Final Validation

- [ ] T-144 Run spec.md acceptance scenario validation: manually verify all scenarios pass
- [ ] T-145 [P] Verify success criteria metrics: registration < 2 min, login < 5 sec, profile < 2 sec, email verification < 10 sec
- [ ] T-146 Verify requirements checklist: all FR and SC items satisfied
- [ ] T-147 [P] Code review: all code follows typescript/react best practices, naming conventions, architecture patterns
- [ ] T-148 [P] Clean up console logs and debug statements

**Checkpoint**: Feature complete, tested, documented, and ready for deployment

---

## Summary

### Task Breakdown by Phase

| Phase | Name | Task Count | Purpose | Status |
|-------|------|-----------|---------|--------|
| 0 | Research & Clarification | N/A | Document decisions | ✅ DONE |
| 1 | Setup & Infrastructure | T-001 to T-020 + T-009a (21 tasks) | Project structure, Keycloak setup | Ready |
| 2 | Foundational Layer | T-021 to T-040b (24 tasks) | Auth services, middleware, validators | Ready |
| 3 | US1: Registration | T-041 to T-059 (19 tasks) | New user account creation | Ready |
| 4 | US2: Login | T-060 to T-080 (21 tasks) | User authentication | Ready |
| 5 | US3: Access Control | T-081 to T-100 (20 tasks) | Protected routes, profile display | Ready |
| 6 | US4: Logout | T-101 to T-114 (14 tasks) | Session termination | Ready |
| 7 | Polish & Testing | T-115 to T-150 (36 tasks) | Refinement, docs, security | Ready |
| | **TOTAL** | **155 tasks** | Complete feature implementation | **READY** |

### By User Story

- **User Story 1 (Registration)**: 19 tasks - screens, form, API route, validation, tests
- **User Story 2 (Login)**: 21 tasks - Auth Code Flow (expo-auth-session), BFF code exchange, API routes, token management, tests
- **User Story 3 (Access Control)**: 20 tasks - auth guard, navigation, profile, role enforcement, tests
- **User Story 4 (Logout)**: 14 tasks - logout action, session termination, multi-device isolation, tests

### Parallelization Opportunities

**Phase 1 Setup**: Tasks T-002, T-003, T-004, T-007, T-010, T-011, T-012, T-014, T-015, T-016, T-017, T-019 can run in parallel (12 parallel opportunities)

**Phase 2 Foundational**: Tasks T-022, T-023, T-024, T-026, T-027, T-028, T-028a, T-028b, T-030, T-031, T-033, T-034, T-035, T-036, T-037, T-038, T-039, T-040, T-040a, T-040b can run in parallel (20 parallel opportunities)

**Phase 3-6 User Stories**: All user stories (1-4) can start after Phase 2 completes. Within each story:
- Phase 3 US1: Tasks T-041, T-042, T-043, T-048, T-052, T-053, T-054, T-055, T-056 marked [P]
- Phase 4 US2: Tasks T-060, T-064, T-069, T-070, T-071, T-072, T-073, T-074, T-075 marked [P]
- Phase 5 US3: Tasks T-081, T-082, T-083, T-084, T-087, T-089, T-091, T-092, T-093, T-094, T-095 marked [P]
- Phase 6 US4: Tasks T-101, T-102, T-105, T-107, T-108, T-109, T-110 marked [P]

**Phase 7 Polish**: Tasks T-115 through T-143 marked [P] can run in parallel

### Dependencies & Execution Order

```
Phase 1: Setup (all Setup tasks can run in parallel)
    ↓ (Setup complete)
Phase 2: Foundational (all can run in parallel, but must complete before Phase 3-6)
    ↓ (Foundational complete - CRITICAL GATE)
Phase 3-6: User Stories 1-4 (all stories can start in parallel after Phase 2)
    ├─ US1: Registration (independent)
    ├─ US2: Login (independent, but can integrate with US1 UI)
    ├─ US3: Access Control (independent, uses auth from US1/US2)
    └─ US4: Logout (independent, uses auth from US1/US2)
    ↓ (All desired user stories complete)
Phase 7: Polish & Testing (all marked [P] can run in parallel)
```

### MVP Scope Suggestion

**Minimum Viable Product (Phase 1-5, US1-3)**:
- Phase 1: Setup & Infrastructure (T-001 to T-020)
- Phase 2: Foundational Layer (T-021 to T-040)
- Phase 3: User Story 1 - Registration (T-041 to T-059)
- Phase 4: User Story 2 - Login (T-060 to T-080)
- Phase 5: User Story 3 - Access Control & Profile (T-081 to T-100)

**MVP Excludes**:
- Phase 6: Logout (US4, P2 - add in v1.1)
- Phase 7: Polish phase items (add incrementally)

**MVP Estimate**: ~10 days (if all parallelizable tasks run in parallel)

### Extended Scope (Full Feature)

**Include All**:
- All 4 user stories (including Phase 6: Logout)
- Full Phase 7: Polish, testing, documentation, security hardening

**Full Feature Estimate**: ~15 days (if parallelizable tasks run in parallel)

---

## Success Criteria Validation

All acceptance scenarios from spec.md will be validated:

✅ **Registration Tests** (US1):
- New user account created in Keycloak with `mc-user` role
- Verification email sent within 5 minutes
- Link valid for 24 hours, expires after
- Email verification immediately activates account
- All password policy requirements enforced

✅ **Login Tests** (US2):
- Valid credentials authenticate < 5 seconds
- Invalid credentials display specific error
- JWT token present in session
- Keycloak unavailability handled gracefully
- Silent token refresh works on background

✅ **Access Control Tests** (US3):
- Profile page loads < 2 seconds
- All user attributes displayed (username, email, first/last name, roles, status)
- Unauthenticated access redirected to login
- Only mc-user and mc-admin roles can access protected screens

✅ **Logout Tests** (US4):
- Logout redirects to login immediately
- Protected screens inaccessible after logout
- Other device sessions remain active
- Multiple concurrent sessions fully independent

---

**Generated**: May 3, 2026  
**Feature Specification**: [spec.md](spec.md)  
**Implementation Plan**: [plan.md](plan.md)
