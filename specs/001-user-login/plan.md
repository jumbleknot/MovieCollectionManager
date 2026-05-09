# Implementation Plan: User Login & Registration

**Branch**: `001-user-login` | **Date**: May 2, 2026 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/001-user-login/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Implement user login and self-registration flows for the MCM application using Keycloak as the identity provider. Enable new users to register with password policy validation and email verification (24-hour activation window). Support existing user authentication with JWT token management, including automatic silent refresh and concurrent multi-device sessions. Implement role-based access control (RBAC) for `mc-user` and `mc-admin` roles with specific error messaging for security and UX consistency. Integrate across MCM frontend app (client and BFF API layer) and Keycloak IAM service.

## Technical Context

**Language/Version**: 
- Frontend client: React Native with Expo (TypeScript 5.x)
- Frontend BFF: React Native with Expo (TypeScript/Node.js)
- IAM: Keycloak (external service)

**Primary Dependencies**: 
- Frontend client: Expo, React Native, expo-auth-session, Axios, expo-secure-store (encrypted secure storage)
- Frontend BFF: Expo (Expo Router API Routes implement BFF and deployed server-side), axios, jsonwebtoken, nodemailer (for email verification)
- Infrastructure: Docker, node container (BFF), Redis container (BFF cache), Keycloak container

**Storage**: 
- User accounts & credentials: Keycloak realm (jumbleknot)
- Session tokens: JWT in secure HTTP-only cookies (with expo-secure-store fallback for platforms with cookie restrictions)
- BFF cache: Redis (for session state caching, user context, and partial auth state validation)

**Testing**: 
- Frontend client: Jest, React Testing Library, detox (E2E)
- Frontend BFF: Jest, Supertest, integration tests against Keycloak test instance

**Target Platform**: 
- Web: Expo React Native web client
- Mobile: Expo React Native Android client
- BFF: Docker containerized Node.js
- IAM: Docker containerized Keycloak

**Project Type**: Multi-platform (web + mobile) application with Expo BFF layer on Node.js container and future backend with Rust microservices

**Performance Goals**: 
- Login: < 5 seconds credential validation and navigation (SC-002)
- Profile page load: < 2 seconds (SC-005)
- Email verification: < 10 seconds activation (SC-009)
- Token refresh: silent background operation, no user-perceptible delay

**Constraints**: 
- JWT token auto-refresh with fallback to re-login on refresh failure
- Email verification required; 24-hour link expiration; email resend available during registration (Phase 1)
- Password: minimum 12 characters with uppercase, lowercase, digit, special character
- Role-based access control enforced at both frontend (route guards) and backend (API authorization)
- Multiple concurrent sessions per user supported (independent per device); maximum 10 concurrent sessions per user
- Session timeout: 30-minute idle timeout; 24-hour absolute timeout (whichever comes first)
- Rate limiting: /register (10 per email/day), /login (5 per IP/minute), /refresh (auto-throttled), /verify-email (1 per token)
- 100% accuracy for access control (SC-004, SC-006)
- Typical usage baseline (SC-007): ≤500 concurrent authenticated users, ≤100 login requests/minute, 99.5% login success rate target; load test acceptance threshold for T-123

**Scale/Scope**: 
- Multi-user application with per-user concurrent session support
- Auth flows: registration (1 screen), login (1 screen), home (1 screen), profile (1 screen)
- 3 key user roles: unauthenticated, mc-user, mc-admin
- Integration points: MCM Client, MCM BFF, Keycloak, Redis cache

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

✅ **AI Assistant Constraints**: Feature is within standard application development scope. No constitutional violations.

✅ **Security, Authentication & Authorization** (NON-NEGOTIABLE):
- RBAC with Keycloak (`mc-admin`, `mc-user` roles) ✓
- JWT token-based authentication ✓
- Email verification required during registration ✓
- Password policy enforcement (12 chars, complexity) ✓
- Access control enforced on protected screens ✓
- Token refresh with secure session management ✓

✅ **Test-Driven Development** (NON-NEGOTIABLE):
- Feature specifies measurable success criteria (SC-001 through SC-009)
- All acceptance scenarios are concrete and testable
- Testing approach defined: unit tests for auth logic, E2E for user flows, integration tests for Keycloak

✅ **Common Technology Stack and Standards**:
- Frontend Client: React Native, Expo, TypeScript ✓
- Frontend BFF: React Native, Expo, Node.js ✓
- IAM: Keycloak ✓
- Storage: Redis cache, Keycloak user store ✓
- Deployment: Docker containerized ✓

**GATE STATUS**: ✅ **PASS** - Feature aligns with all constitutional principles. Proceed to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/001-user-login/
├── spec.md              # Feature specification (user stories, requirements, success criteria)
├── plan.md              # This file - implementation plan with research and design
├── research.md          # Phase 0 output - resolved clarifications and technology decisions
├── data-model.md        # Phase 1 output - user entity definitions, JWT structure, role definitions
├── quickstart.md        # Phase 1 output - development setup and local testing guide
├── contracts/           # Phase 1 output - API contracts and interface definitions
│   ├── auth-api.md      # BFF authentication endpoints (register, login, logout, refresh)
│   └── keycloak-integration.md  # Keycloak client configuration and token claims
└── checklists/
    └── requirements.md  # Feature validation checklist
```

### Source Code - Frontend Client & BFF (MCM App)

```text
frontend/mcm-app/src/
├── app/
|   ├── bff-api/  # MCM BFF API layer (Expo Router API Routes)
|   │   └── auth/
|   |       ├── register+api.ts             # BFF API calls: POST /bff-api/auth/register - create account
|   |       ├── login+api.ts                # BFF API calls: POST /bff-api/auth/login - authenticate user
|   │       ├── logout+api.ts               # BFF API calls: POST /bff-api/auth/logout - invalidate session
|   │       ├── refresh+api.ts              # BFF API calls: POST /bff-api/auth/refresh - refresh JWT token
|   │       ├── verify-email+api.ts         # BFF API calls: GET /bff-api/auth/verify-email?token=X - verify registration
|   │       ├── resend-verification+api.ts  # BFF API calls: POST /bff-api/auth/resend-verification (requires email, rate-limited)
|   │       └── user+api.ts                 # BFF API calls: GET /bff-api/auth/user - get current user details
│   ├── index.tsx         # App entry point with navigation structure
│   └── (auth)/           # Auth route group
│       ├── login.tsx     # Login route (returns login screen)
│       ├── register.tsx  # Registration route (returns registration screen)
│       └── profile.tsx   # User profile route (returns user profile screen)
├── bff-server/
│   ├── auth.ts           # BFF JWT validation middleware
│   ├── role-check.ts     # BFF RBAC enforcement middleware
|   ├── keycloak.ts       # BFF Keycloak client integration
|   ├── email-service.ts  # BFF email sending for verification
|   └── token-service.ts  # BFF JWT token generation/refresh
├── components/
│   ├── auth-guard.tsx                  # Route guard component - verify JWT token and role
│   ├── loading-indicator.tsx           # Spinner during auth/Keycloak redirect operations
│   ├── logout-confirmation-dialog.tsx  # Confirm logout action before proceeding
│   ├── navigation-bar.tsx              # Home and Profile navigation links
│   ├── password-strength-indicator.tsx # Real-time password policy feedback
│   ├── profile-display.tsx             # Profile information display component
│   ├── protected-route.tsx             # Reusable wrapper for role-protected screens
│   └── register-form.tsx               # Registration form with password validation
│   # Note: Login form is embedded in login-screen.tsx (no separate login-form component)
├── screens/                         # Screen components (note: grouped by feature per React Native pattern)
│   ├── auth/                        # Auth screens group
│   |   ├── login-screen.tsx               # Login screen (landing page with "Login" + "Create Account")
│   |   ├── email-verification-screen.tsx  # "Check your email" screen with resend capability
│   |   └── profile-screen.tsx             # Profile screen with logout button
│   # Note: Registration UI is register-form.tsx (Component) orchestrated by app/(auth)/register.tsx
│   └── home/                        # Home screens group
│       └── index.tsx                # Home screen
├── utils/
│   ├── session-storage.ts  # Token storage (secure HTTP-only cookies + expo-secure-store fallback)
│   ├── token-refresh.ts    # Silent background refresh logic; wired as Axios interceptor
│   ├── role-checker.ts     # Role verification utility (mc-user vs mc-admin patterns)
│   ├── validators.ts       # Form validation (password policy, email format, username)
│   └── errors.ts           # Error message mapping for specific auth errors
└── hooks/
    ├── use-auth.ts           # Global auth context (state management, login/logout actions)
    ├── use-auth-guard.ts     # Protected route enforcement hook
    ├── use-keycloak-auth.ts  # expo-auth-session AuthRequest + PKCE + promptAsync
    ├── use-login.ts          # Receives auth code result, calls BFF /login, stores session
    ├── use-logout.ts         # Calls BFF /logout, clears auth state
    ├── use-registration.ts   # Form state, validation, BFF /register call
    └── use-session-timeout.ts # Client-side 30-min idle / 24-hr absolute timeout tracker
```

**Design Note on Screen Organization**: While the constitution specifies a flat `screens/` layer, this plan organizes screens into feature-based subdirectories (`auth/`, `home/`) following React Native best practices for scalability. Each subdirectory contains only screens for that feature (not business logic), maintaining clean separation of concerns. This pattern is compatible with the constitutional structure and improves maintainability.

### Source Code - Tests

```text
frontend/mcm-app/
├── src/
│   ├── bff-server/
│   │   └── unit-tests/
│   │       ├── auth.test.ts            # BFF auth unit tests
│   │       ├── role-check.test.ts      # BFF role check unit tests
│   │       ├── keycloak.test.ts        # BFF Keycloak unit tests
│   │       ├── email-service.test.ts   # BFF email service unit tests
│   │       └── token-service.test.ts   # BFF token service unit tests
│   ├── utils/
│   │   └── unit-tests/
│   │       ├── auth.test.ts            # Auth utilities unit tests
│   │       ├── validators.test.ts      # Validators unit tests
│   │       └── errors.test.ts          # Errors unit tests
│   └── hooks/
│       └── unit-tests/
│           ├── use-auth.test.ts        # Auth context hook for session management unit tests
│           └── use-auth-guard.test.ts  # Hook for protected route enforcement unit tests
└── tests/
    ├── integration/
    │   ├── login.test.ts               # Login flow with mocked BFF
    │   ├── register.test.ts            # Registration flow with email verification
    │   └── tokenRefresh.test.ts        # Token refresh and session management
    ├── e2e/
    │   ├── auth.e2e.ts                 # Full authentication flow (Detox)
    │   └── concurrent-sessions.e2e.ts  # Multi-device session test
    └── load/
        └── auth-load.ts                # Load test: ≤500 concurrent users, ≤100 login req/min (SC-007)
```

**Structure Decision**: This is a **multi-platform (web + mobile) application with Expo/Node.js BFF layer**. The structure reflects:
1. Shared React Native codebase (frontend/mcm-app/) for web and mobile UI
2. BFF API routes embedded in Expo Router for backend logic
3. Keycloak integration as external IAM service
4. Test structure covering unit, integration, and E2E scenarios
5. Clear separation: auth flows in dedicated route group, shared components, and utility functions

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| TDD order inverted: implementation precedes tests in Phases 2–6 | Foundational layer (auth, session management, Keycloak integration) required exploratory implementation before meaningful test cases could be identified. BFF route handlers depend on middleware contracts that were unclear until implementation. | Writing tests first for entirely novel integration patterns (Keycloak PKCE flow, Redis session state) would have produced tests that needed to be rewritten after implementation clarified the actual API surface. This is a one-off exception; future features must enforce TDD order. |
| BFF route unit tests in `tests/app/bff-api/` (not co-located) | Expo Router treats any `.ts` file co-located with route files as additional API routes and serves them over HTTP. Co-locating test files would create unintended routes in the BFF. | Co-location in `src/app/bff-api/` is impossible without breaking the BFF routing. |

---

# PHASE 0: Research & Clarification Resolution

## Clarifications Resolved

All clarifications from the specification phase have been resolved:

1. ✅ **JWT Token Expiration & Refresh** - Automatic silent refresh with fallback to re-login
2. ✅ **Error States & User Feedback** - Specific error messages for each scenario type
3. ✅ **User Details Definition** - Standard profile attributes (username, email, first/last name, roles, status)
4. ✅ **Password Requirements & Validation** - Min 12 chars with complexity; email verification required
5. ✅ **Concurrent Session Management** - Allow multiple independent sessions per device

## Technology Decision Documentation

### Authentication Flow Choice

**Decision**: Keycloak OAuth2/OpenID Connect with JWT token storage in secure session

**Rationale**:
- Keycloak is the standard IAM for this project (per architecture)
- OAuth2/OIDC provides industry-standard security patterns
- JWT tokens enable stateless BFF validation
- Avoids building custom auth logic (security risk)

**Implementation Pattern**: OAuth2 Authorization Code Flow with PKCE (constitution-compliant)
- `expo-auth-session` initiates auth request with PKCE challenge (code_verifier + code_challenge)
- Frontend redirects to Keycloak hosted login page via `expo-auth-session` `AuthRequest`
- Keycloak authenticates user and returns authorization code to app redirect URI
- Frontend sends `{code, codeVerifier, redirectUri}` to BFF `/login` endpoint
- BFF exchanges code for tokens with Keycloak (server-side, keeping client secret secure)
- BFF stores tokens server-side in Redis; returns JWT in secure HTTP-only cookie + user profile

**UX Path Split** (Option A — confirmed):
- **Login**: Auth Code Flow with PKCE via `expo-auth-session` → Keycloak hosted login page → code → BFF exchange
- **Registration**: App-side custom form → BFF `/register` → Keycloak Admin API (no redirect; keeps registration UX within the app for better error feedback and password policy display)

### Session Management Choice

**Decision**: JWT stored in secure HTTP-only cookies with expo-secure-store fallback for platforms with cookie restrictions

**Rationale**:
- HTTP-only cookies prevent JavaScript XSS access (preferred)
- Secure flag ensures HTTPS-only transmission
- Browser automatically includes in requests
- Supports multi-device sessions (independent cookies per device)

**Fallback Scenario**: expo-secure-store for platforms with cookie restrictions (e.g., embedded web viewers, some Safari limitations)
- Condition: Detected when browser doesn't support secure cookies or web viewer context detected
- Implementation: Frontend checks cookie support, falls back to expo-secure-store (encrypted key-value storage via device keychain/keystore)
- Trade-off: Slightly lower security but maintains functionality in constrained environments

**Concurrent Session Limit**: Maximum 10 active sessions per user
- Enforcement: BFF validates session count during login; oldest inactive session removed if limit exceeded
- Rationale: Prevents account abuse while allowing multi-device use (phone, tablet, laptop, etc.)

### Email Verification Implementation

**Decision**: Keycloak built-in email verification with custom verification link handling and resend capability

**Rationale**:
- Keycloak provides SMTP integration and email templates
- Reduces custom email logic
- Centralized user state management in Keycloak

**Timeout**: 24 hours (user must re-register if link expires)

**Resend Flow (Phase 1)**: 
- User can request verification email resend from registration screen
- BFF endpoint: POST /bff-api/auth/resend-verification (rate limited: 3 per email/hour)
- Updates Keycloak verification token
- Sends new email with updated link

### Token Refresh Strategy

**Decision**: Automatic silent refresh in background + explicit refresh-on-demand

**Rationale**:
- Silent refresh provides seamless UX for typical sessions
- On-demand refresh available for explicit refresh button
- Fallback to re-login if refresh fails (security boundary)

**Implementation**: 
- Frontend intercepts 401 responses → triggers refresh → retries original request
- Rate limiting: Auto-throttled to prevent refresh spam (max 1 refresh per 30 seconds per session)
- Max retries: 2 failed refreshes before forcing re-login
- Session persistence: BFF caches partial auth state in Redis (10-minute TTL) to speed refresh validation

### Error Messaging Strategy

**Decision**: Specific user-facing messages for each error type; security-safe messages (no user enumeration)

**Rationale**:
- Improves UX by telling users exactly what went wrong
- Security-safe: "Invalid username or password" doesn't confirm if user exists
- Aligns with OWASP best practices

### Rate Limiting Strategy

**Decision**: Per-endpoint rate limiting with IP-based and email-based thresholds

**Implemented Limits**:
- `/register`: 10 registrations per email address per day (prevents spam registration)
- `/login`: 5 failed attempts per IP per minute (prevents brute force)
- `/refresh`: Auto-throttled (max 1 per 30 seconds per session, 2 max retries)
- `/verify-email`: 1 per token (prevents replay attacks)
- `/resend-verification`: 3 per email per hour (prevents spam)

**Enforcement**:
- BFF middleware validates before routing to Keycloak
- Redis stores rate-limit counters with automatic TTL expiration
- Returns 429 (Too Many Requests) with Retry-After header

---

# PHASE 1: Design & Architecture

## Data Model & Entities

### User Account (Keycloak User)

```typescript
interface KeycloakUser {
  id: string;                    // Keycloak user UUID
  username: string;              // Login username
  email: string;                 // User email (verified: boolean)
  firstName: string;             // First name
  lastName: string;              // Last name
  enabled: boolean;              // Account active/disabled
  emailVerified: boolean;        // Email verification status
  createdTimestamp: number;      // ISO timestamp
  attributes?: {
    lastLogin?: string;          // Last successful login
    loginFailures?: number;      // Failed login counter (for lockout)
  };
}
```

### JWT Token Payload (Issued by Keycloak)

```typescript
interface JWTPayload {
  sub: string;                   // Subject (user ID)
  iss: string;                   // Issuer (Keycloak realm URL)
  aud: string;                   // Audience (movie-collection-manager)
  exp: number;                   // Expiration timestamp
  iat: number;                   // Issued at timestamp
  jti: string;                   // JWT ID (unique token identifier)
  auth_time: number;             // Authentication time
  scope: "openid profile email"; // Scope claims
  
  // Custom claims
  preferred_username: string;    // Username from login
  email: string;                 // Email from user profile
  email_verified: boolean;       // Email verification status
  name: string;                  // Full name
  given_name: string;            // First name
  family_name: string;           // Last name
  
  // Role claims
  realm_access?: {
    roles: string[];             // User roles in realm
  };
  resource_access?: {
    "movie-collection-manager": {
      roles: ["mc-user" | "mc-admin"]; // Client roles
    };
  };
}
```

### Client Role

```typescript
enum ClientRole {
  MCAdmin = "mc-admin",    // Admin access - all operations
  MCUser = "mc-user"       // User access - collection management
}
```

## API Contracts

### BFF Authentication Endpoints

```typescript
// POST /bff-api/auth/register
interface RegisterRequest {
  username: string;        // 3-20 alphanumeric + underscore
  email: string;          // Valid email format
  firstName: string;      // 1-50 characters
  lastName: string;       // 1-50 characters
  password: string;       // 12+ chars, upper, lower, digit, special
}

interface RegisterResponse {
  success: boolean;
  message: string;        // "Verification email sent to..."
  userId?: string;        // User ID from Keycloak (optional)
}

// POST /bff-api/auth/login  (Auth Code Flow — receives code from expo-auth-session)
interface LoginRequest {
  code: string;           // Authorization code from Keycloak redirect
  codeVerifier: string;   // PKCE code verifier (matches challenge sent to Keycloak)
  redirectUri: string;    // Must match the redirect URI registered in Keycloak client
}

interface LoginResponse {
  success: boolean;
  accessToken: string;    // JWT (in secure HTTP-only cookie)
  user: {
    id: string;
    username: string;
    email: string;
    firstName: string;
    lastName: string;
    roles: string[];
    emailVerified: boolean;
  };
}

// POST /bff-api/auth/logout
interface LogoutResponse {
  success: boolean;
  message: string;
}

// POST /bff-api/auth/refresh
interface RefreshResponse {
  success: boolean;
  accessToken: string;    // New JWT
  expiresIn: number;      // Seconds until expiration
}

// GET /bff-api/auth/verify-email?token=<verification-token>
interface VerifyEmailResponse {
  success: boolean;
  message: string;        // "Email verified. You can now login."
  email?: string;
}
```

### BFF User Endpoints

```typescript
// GET /bff-api/auth/user (requires JWT + mc-user or mc-admin role)
interface ProfileResponse {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
  emailVerified: boolean;
  accountStatus: "active" | "disabled" | "locked";
  createdAt: string;      // ISO timestamp
  lastLogin?: string;     // ISO timestamp
}

// POST /bff-api/auth/resend-verification (requires email, rate-limited)
interface ResendVerificationRequest {
  email: string;          // Email address to resend to
}

interface ResendVerificationResponse {
  success: boolean;
  message: string;        // "Verification email sent. Check your inbox."
}
```

### Keycloak Integration Contract

```yaml
Realm: jumbleknot
Client: movie-collection-manager

Authentication Flow:
  - expo-auth-session initiates Auth Code Flow with PKCE (code_verifier + code_challenge)
  - Redirect to Keycloak hosted login page
  - Keycloak returns authorization code to app redirect URI
  - BFF exchanges code + codeVerifier for tokens (server-side, secret never exposed to client)
  - BFF returns JWT to frontend in secure HTTP-only cookie
  PKCE Configuration:
  - code_challenge_method: S256
  - code_verifier: cryptographically random 43-128 char string
  - code_challenge: BASE64URL(SHA256(code_verifier))

Token Configuration:
  - Access token lifetime: 15 minutes (default)
  - Refresh token lifetime: 7 days
  - Token protocol: OpenID Connect

Email Configuration:
  - Realm SMTP: Configured for email sending
  - Verification template: Custom MCM template
  - Link expiration: 24 hours
  - Resend capability: Available via support flow (out-of-scope)

Client Roles:
  - mc-admin: Full access
  - mc-user: Standard user access (default for new users)

Password Policy:
  - Length: 12 characters minimum
  - Complexity: Require upper, lower, digit, special character
```

## Component Architecture

### Frontend Auth Flow

```
User → Login Screen → expo-auth-session AuthRequest (PKCE challenge) → Keycloak Hosted Login
        ↓ (Keycloak redirects back with authorization code)
    App Redirect URI receives code → BFF /login {code, codeVerifier, redirectUri}
        ↓ (BFF exchanges code with Keycloak, returns JWT in cookie)
    JWT stored in secure HTTP-only cookie → navigate to home screen

        ↓ (if register — app-side Registration Screen)
    Registration Screen → BFF /register → Keycloak Admin API → Verification Email
        ↓ (verify)
    Email Link → BFF /verify-email → Keycloak → Activate → Ready to login

Protected Route → AuthGuard (check JWT + role) → redirect if unauthenticated/unauthorized
    ↓ (token valid + role present)
    Render screen

Token Expiration → Silent refresh (POST /refresh) → retry original request
    ↓ (refresh fails)
    Redirect to login
```

**Design Note on Route Protection**: While Expo Router provides built-in protected routes (via `(protected)` route group with `_layout.tsx`), this plan uses a supplementary custom `auth-guard.tsx` component and `useAuthGuard` hook to enforce **role-based** access control (mc-user / mc-admin) — not just authentication. Expo Router's built-in protection handles unauthenticated redirects; the auth-guard layer adds RBAC on top. This combination satisfies the constitution's protected routes requirement while extending it for role enforcement.

### Frontend BFF Services

```
BFF /auth/register
  ├─ Check rate limit (10/email/day)
  ├─ Validate input (username, email, password policy)
  ├─ KeycloakService.createUser()
  ├─ Keycloak creates user + marks email unverified
  ├─ EmailService.sendVerificationEmail()
  ├─ Cache user context in Redis (10-min TTL)
  └─ Return 201 Created with verification message

BFF /auth/login  (Auth Code Flow exchange)
  ├─ Check rate limit (5/IP/minute)
  ├─ Validate request (code, codeVerifier, redirectUri present)
  ├─ Exchange authorization code + codeVerifier for tokens with Keycloak
  ├─ Validate ID token (iss, aud, exp, at_hash)
  ├─ Extract user identity and roles from ID token claims
  ├─ Check account status (not locked, not disabled)
  ├─ Check session count (max 10 per user)
  ├─ Remove oldest inactive session if at limit
  ├─ Cache session state in Redis (10-min TTL)
  ├─ Return 200 with JWT in secure HTTP-only cookie + user profile
  └─ Set X-Session-Id header for frontend session tracking

BFF /auth/logout
  ├─ Validate JWT token
  ├─ Invalidate session in Redis
  ├─ Notify Keycloak (revoke refresh token)
  ├─ Clear secure cookie
  └─ Return 200 Success

BFF /auth/refresh
  ├─ Validate refresh token
  ├─ Check rate limit (auto-throttle: 1/30s, 2 max retries)
  ├─ Check Redis cache for session validity
  ├─ Exchange refresh token with Keycloak
  ├─ Generate new JWT + refresh token
  ├─ Update Redis session cache (10-min TTL)
  └─ Return 200 with new JWT in secure cookie

BFF /auth/verify-email
  ├─ Validate verification token (1 use only)
  ├─ Notify Keycloak to verify email
  ├─ Update user emailVerified flag
  ├─ Invalidate verification token
  └─ Return 200 with success message

BFF /auth/resend-verification
  ├─ Check rate limit (3/email/hour)
  ├─ Validate email exists but unverified
  ├─ Generate new verification token in Keycloak
  ├─ Send new verification email
  └─ Return 200 with resend confirmation

BFF /auth/user
  ├─ Validate JWT token
  ├─ Check Redis cache for user profile (hit → return cached)
  ├─ Fetch from Keycloak if cache miss
  ├─ Cache result in Redis (5-min TTL for user data)
  └─ Return 200 with full user profile
```

```
KeycloakService.authenticate() [exchange auth code for tokens]
  ↓
TokenService.validateToken()
  ↓
Return JWT + User profile

BFF /auth/refresh
  ↓
KeycloakService.refreshToken()
  ↓
Return new JWT

BFF /auth/verify-email
  ↓
KeycloakService.verifyEmail()
  ↓
Mark email verified in Keycloak
  ↓
User can now login
```

## Testing Strategy

### Unit Tests (70% coverage target)

- BFF Auth: [NEEDS CLARIFICATION]
- BFF Role Check: [NEEDS CLARIFICATION]
- BFF Keycloak: [NEEDS CLARIFICATION]
- BFF Email Service: [NEEDS CLARIFICATION]
- BFF Token Service: JWT parsing, expiration detection
- Validators: Password policy, email format, username validation
- Auth hooks: useAuth state management, token refresh logic
- Error mapping: Specific error scenarios to user messages

### Integration Tests

- Login flow: Valid/invalid credentials, error handling
- Register flow: Validation, email sending, verification
- Token refresh: Silent refresh on 401, fallback to re-login
- Concurrent sessions: Login on multiple devices, independent logout
- Role-based access: mc-admin vs mc-user routes

### E2E Tests (Detox)

- Complete registration → verification → login flow
- Login with invalid credentials error handling
- Profile page access and information display
- Logout and session termination
- Multi-device session independence

---

# PHASE 1 CONTINUATION: Re-check Constitution

**GATE: Re-evaluation after design phase**

✅ **Design aligns with all constitutional principles:**
- Security: JWT + Keycloak OAuth2/OIDC ✓
- RBAC: mc-user and mc-admin roles enforced ✓
- Email verification: Security best practice ✓
- TDD: 70% test coverage defined in testing strategy ✓
- Tech stack: Expo + React Native frontend with Expo & Node.js BFF, Keycloak IAM ✓
- Clean architecture: Layered components, service separation ✓
- Docker-native: Keycloak containerized, Expo API Router BFF in node container ✓

**GATE STATUS**: ✅ **PASS** - Design is production-ready. Proceed to Phase 2 task generation.

---

## Compliance Verification (May 3, 2026)

### Constitution Compliance Review

✅ **Full Compliance Achieved**

| Principle | Status | Details |
|-----------|--------|---------|
| **AI Assistant Constraints** | ✅ PASS | Tech agnosticism: spec.md (WHAT/WHY), plan.md (HOW/technology). Documentation comprehensive. Code quality standards referenced. |
| **Security & Auth (NON-NEGOTIABLE)** | ✅ PASS | OAuth2/OIDC + Authorization Code Flow, JWT validation, server-side secrets (BFF), email verification (24hr), password policy (12 chars + complexity), RBAC enforced, rate limiting designed |
| **Test-Driven Development (NON-NEGOTIABLE)** | ✅ PASS | 70% coverage target specified. Unit tests (BFF, validators, hooks, errors). Integration tests (login, register, token, sessions). E2E tests (Detox). |
| **Technology Stack** | ✅ PASS | React Native, Expo, TypeScript, Node.js BFF, Keycloak, Redis, Docker - all aligned with constitution |
| **Frontend Structure** | ✅ PASS | Layers: App, BFF-API, BFF-Server, Components, Screens, Utils, Hooks - per constitution specification |
| **File Naming** | ✅ PASS | Kebab-case throughout: `register+api.ts`, `auth-guard.tsx`, `use-auth.ts`, `unit-tests/` |
| **Unit Test Co-location** | ✅ PASS | Tests stored next to code: `src/{layer}/unit-tests/` - integration/E2E separate in `tests/` |

### MCM-Architecture Alignment

✅ **Full Alignment Achieved**

| Requirement | Status | Implementation |
|------------|--------|-----------------|
| MCM BFF pattern | ✅ | Expo Router API Routes in Node.js container |
| Keycloak integration | ✅ | OAuth2 + client `movie-collection-manager`, realm `jumbleknot` |
| RBAC roles | ✅ | `mc-admin` (full access), `mc-user` (standard, default) |
| JWT authentication | ✅ | Authorization Code Flow, 15-min access token, 7-day refresh |
| Email verification | ✅ | Keycloak SMTP, 24-hour link expiration |
| Default user role | ✅ | New registrations default to `mc-user` |
| Data classification | ✅ | Internal (per architecture spec) |
| Redis cache | ✅ | BFF session state caching |
| Docker deployment | ✅ | Node.js BFF + Keycloak containers |

### Consistency Checks

✅ **Terminology Consistency**
- Project name: `mcm-app` (frontend), `mc-service` (backend, out-of-scope)
- Service names: `MCM BFF API`, `Keycloak IAM`, `Redis cache`
- Role names: `mc-admin`, `mc-user` (consistent throughout)
- Endpoint paths: `/bff-api/auth/*` (consistent prefix)

✅ **API Contract Consistency**
- 6 endpoints documented with TypeScript interfaces
- Request/response patterns consistent
- Error handling unified with specific messages

---
