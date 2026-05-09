# Feature Specification: User Login & Registration

**Feature Branch**: `001-user-login`  
**Created**: May 2, 2026  
**Status**: Draft  
**Input**: PRD provided at `docs/PRD-UserLogin.md`

## Clarifications

### Session 2026-05-02

- Q: How should JWT token expiration be handled during active sessions? → A: Automatically refresh JWT token silently in background; fall back to re-login if refresh fails
- Q: How should errors be communicated to users during authentication? → A: Display specific user-friendly messages for each error type with recovery guidance
- Q: Which user attributes should be displayed on the profile page? → A: Standard details - username, email, first name, last name, and assigned roles
- Q: What password policy and email verification requirements should be enforced? → A: Minimum 12 characters, must include uppercase, lowercase, digit, and special character; email verification required
- Q: Should users be allowed multiple concurrent sessions on different devices? → A: Yes, allow multiple concurrent sessions; each device maintains independent JWT; user can be logged in on multiple devices simultaneously

## User Scenarios & Testing *(mandatory)*

### User Story 1 - New User Self-Registration (Priority: P1)

A new user discovers the MCM application and wants to create an account to start using the service. The user accesses the login screen and selects the option to create a new account, providing their credentials.

**Why this priority**: Account creation is the entry point for any new user. Without this capability, the application cannot gain new users. This is the critical first step in the user journey.

**Independent Test**: Can be fully tested by visiting the login screen, clicking "Create Account," providing registration details, and verifying the account is created with `mc-user` role. This delivers the value of enabling new users to join the platform.

**Acceptance Scenarios**:

1. **Given** a new user is on the login screen, **When** the user selects "Create Account", **Then** a registration form is displayed within the app
2. **Given** a user is on the registration form, **When** the user enters valid credentials meeting the password policy and submits, **Then** the account is created in the identity provider with the `mc-user` role and a verification email is sent
3. **Given** a user has received a verification email, **When** the user clicks the verification link within 24 hours, **Then** the email is marked as verified and the account is fully activated
4. **Given** an account has been verified, **When** the user tries to login with those credentials, **Then** the login succeeds and the user is navigated to the home screen
5. **Given** a new account is created, **When** the system checks the account roles, **Then** the account has only the `mc-user` role assigned
6. **Given** a user is registering and provides invalid data or weak password, **When** they submit the form, **Then** a specific error message is displayed indicating which fields are invalid and what corrections are needed

---

### User Story 2 - Existing User Login (Priority: P1)

An existing user returns to the MCM application and wants to login with their credentials to access their data and continue using the service.

**Why this priority**: Returning users must be able to access the application with their existing credentials. This is equally critical to registration as it enables users to access their data after the initial signup.

**Independent Test**: Can be fully tested by pressing the "Login" button on the login screen, completing authentication on the identity provider login page, and verifying the user is redirected back to the app and navigated to the home screen with an active session. This delivers the core value of session access.

**Acceptance Scenarios**:

1. **Given** a user is on the login screen, **When** the user selects "Login", **Then** they are redirected to the identity provider's hosted login page; after entering valid credentials on the identity provider's login page, they are redirected back to the app, authenticated, and navigated to the home screen
2. **Given** a user is redirected to the identity provider's login page, **When** the user enters invalid credentials and submits, **Then** the identity provider displays an error and the user remains on the identity provider's login page; after dismissing, they return to the app login screen
3. **Given** a user has successfully logged in, **When** the user's session is examined, **Then** the user has an active authenticated session
4. **Given** the authentication service is unavailable, **When** a user attempts to login, **Then** a specific error message is displayed indicating the service is unavailable with a suggestion to try again later

---

### User Story 3 - Access Control & Navigation (Priority: P1)

After logging in, a user wants to navigate the application and access the profile page to view their account information and manage their session.

**Why this priority**: Once authenticated, users must be able to navigate to protected screens and access their profile. This validates that access control is working and provides users visibility into their account status.

**Independent Test**: Can be fully tested by logging in, navigating to the profile page, and verifying profile information is displayed. This delivers the value of showing users they are authenticated and providing account management access.

**Acceptance Scenarios**:

1. **Given** a user is logged in, **When** the user navigates to the profile page, **Then** the profile page is displayed with the user's account information
2. **Given** a user is on the profile page, **When** the profile page is examined, **Then** it displays: username, email, first name, last name, assigned client roles, and account status
3. **Given** a user has not logged in, **When** the user tries to access the profile page directly, **Then** they are redirected to the login screen
4. **Given** a user is logged in with `mc-user` or `mc-admin` role, **When** the user accesses a protected screen, **Then** the access is granted

---

### User Story 4 - Logout & Session Termination (Priority: P2)

A user has finished using the MCM application and wants to logout to end their session and return to the login screen.

**Why this priority**: Logout is essential for security, allowing users to end their sessions. This is particularly important in shared device scenarios. It's P2 because while critical for security, the initial login flows (P1) must work first.

**Independent Test**: Can be fully tested by logging in, navigating to the profile page, selecting logout, and verifying the user is returned to the login screen and cannot access protected screens without re-authenticating. This delivers security value.

**Acceptance Scenarios**:

1. **Given** a user is logged in and on the profile page, **When** the user selects the logout option, **Then** the session is terminated and the user is redirected to the login screen
2. **Given** a user has just logged out from one device, **When** the user accesses the application on another device where they have an active session, **Then** the other session remains valid and they are not logged out
3. **Given** a user is logged in on Device A, **When** the user logs in from Device B with the same credentials, **Then** both sessions remain active and independent
4. **Given** a user has two active sessions and the token expires on Device A, **When** the system attempts silent refresh on Device A, **Then** the other session on Device B remains unaffected and usable

---

### Edge Cases

- **Invalid registration data**: When a user provides invalid input (missing fields, invalid email format, or password not meeting requirements), system displays specific error message indicating what is invalid and how to correct it
- **Weak password during registration**: When a user provides a password that does not meet complexity requirements (< 12 characters, missing uppercase/lowercase/digit/special char), system displays message: "Password must be at least 12 characters and contain uppercase, lowercase, digit, and special character."
- **Duplicate username on registration**: When a user attempts to register with a username that already exists, system displays message: "This username is already taken. Please choose another."
- **Email verification pending**: When a user completes registration but has not yet verified their email, system displays message: "Please verify your email address to activate your account. Check your inbox for the verification link." and does not allow login until verification is complete
- **Email verification link expired**: When a user clicks an email verification link that has expired (>24 hours), the system deletes the expired unverified account from the identity provider before returning an error, then displays message: "This verification link has expired. Your account has been removed — please register again with the same email address." This ensures re-registration with the same email succeeds without a duplicate-user conflict.
- **Invalid login credentials**: When a user enters incorrect credentials on the identity provider's hosted login page, the identity provider displays its standard invalid credentials message; upon return to the app the error is surfaced as "Authentication failed. Please check your credentials and try again."
- **Account locked**: When a user's account is locked after failed login attempts, system displays message: "Your account is locked. Please contact support." with a link to support/recovery options
- **JWT token expiration**: When a JWT token expires during an active session, system automatically refreshes the token in the background; if refresh fails, user is redirected to login with message: "Your session has expired. Please log in again."
- **Authentication service unavailable**: When the authentication service is unreachable during login/registration, system displays message: "Authentication service is unavailable. Please try again later." with timestamp of attempt
- **Account disabled or roles revoked**: When a user's account is disabled or roles are removed after login, system displays message: "Your account access has been revoked. Please contact support." when attempting to access protected screens
- **Multiple concurrent sessions**: When a user logs in from a second device while already logged in on the first device, both sessions remain active independently; logout from one device does not affect the other
- **Token expiration in one session**: When a JWT token expires in one active session, system automatically attempts silent refresh; refresh failure only affects that session; other concurrent sessions remain valid
- **Session idle timeout (30 minutes)**: When a user has been inactive for 30 minutes, system automatically terminates the session and displays message: "Your session has expired due to inactivity. Please log in again." on next interaction
- **Session absolute timeout (24 hours)**: When a user's session reaches 24 hours from initial login, system automatically terminates the session regardless of activity level and displays message: "Your session has expired. Please log in again."

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a login screen as the initial application screen when a user is not authenticated
- **FR-002**: System MUST provide a self-registration flow allowing new users to create an account with required credentials
- **FR-003**: System MUST validate user credentials against the external identity provider during login
- **FR-004**: System MUST create new user accounts in the identity provider with the `mc-user` role by default during self-registration
- **FR-004a**: System MUST enforce password requirements during registration: minimum 12 characters, must contain at least one uppercase letter, one lowercase letter, one digit, and one special character (@, #, $, !, etc.)
- **FR-004b**: System MUST require email verification during registration; users must verify their email address before account activation
- **FR-004c**: System MUST send a verification email with a link that expires after 24 hours; if the user does not verify within 24 hours, the system MUST delete the unverified user account from the identity provider before returning an error, ensuring re-registration with the same email address succeeds without conflict
- **FR-005**: System MUST store and maintain JWT tokens in the user session after successful authentication
- **FR-005a**: System MUST automatically refresh expired JWT tokens silently in the background without user interaction
- **FR-005b**: System MUST redirect the user to the login screen if token refresh fails or refresh token is invalid
- **FR-006**: System MUST validate JWT token membership in either `mc-admin` or `mc-user` client roles for access to protected screens
- **FR-007**: System MUST restrict access to all protected screens (except login and registration) to authenticated users only
- **FR-008**: System MUST provide a navigation bar on authenticated screens with links to "Home" and "Profile"
- **FR-009**: System MUST provide a Profile page that displays the logged-in user's: username, email address, first name, last name, assigned client roles, and account status
- **FR-010**: System MUST provide a logout option on the Profile page
- **FR-011**: System MUST terminate the user session and clear the JWT token when logout is selected
- **FR-012**: System MUST navigate the user to the login screen immediately after logout
- **FR-012a**: System MUST support multiple concurrent sessions for the same user account across different devices and browsers
- **FR-012b**: System MUST allow users to logout from the current device without affecting sessions on other devices
- **FR-012c**: System MUST maintain independent JWT tokens for each concurrent session; expiration of one token does not affect other sessions
- **FR-013**: System MUST handle authentication errors gracefully by displaying specific, user-friendly error messages that indicate the error type and suggest recovery actions without exposing internal system details
- **FR-014**: System MUST integrate with an external identity provider for all authentication and user management operations
- **FR-015**: System MUST automatically terminate sessions after 30 minutes of inactivity (idle timeout) or 24 hours from initial login (absolute timeout), whichever comes first; idle-timeout sessions MUST redirect users to the login screen with message "Your session has expired due to inactivity. Please log in again."; absolute-timeout sessions MUST redirect with message "Your session has expired. Please log in again."

### Key Entities

- **User Account**: Represents a user in the system with the following attributes stored in the identity provider: username, email, first name, last name, account creation date, account status (active/disabled/locked), and assigned client roles
- **JWT Token**: Represents an authenticated user session containing user identity, role information, token issue time, expiration time, and refresh token
- **Client Role**: Represents permissions assigned to a user account (`mc-user` or `mc-admin`); determines which screens and operations are accessible

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: New users can complete the registration form (including password validation and email entry) in under 2 minutes; system dispatches the verification email request within 30 seconds of successful registration (end-to-end delivery depends on the email relay, typically within 5 minutes); account can be fully activated within 24 hours
- **SC-002**: Existing users can login with valid credentials within 5 seconds and be navigated to the home screen
- **SC-003**: System rejects weak passwords, invalid credentials, and unauthorized access with 100% accuracy
- **SC-004**: Users cannot access protected screens (Profile, Home) without valid JWT token authentication (100% of attempts blocked)
- **SC-005**: Profile page loads and displays all user account attributes (username, email, first name, last name, roles, status) within 2 seconds of navigation
- **SC-006**: Users successfully complete logout and are unable to access protected screens after logout (100% of logout attempts effective)
- **SC-007**: System maintains stable authentication under typical usage patterns: ≤500 concurrent authenticated users, ≤100 login requests per minute; 99.5% login success rate; p95 login response ≤5 seconds; p95 profile page response ≤2 seconds; p95 email verification response ≤10 seconds
- **SC-008**: All access control decisions are enforced consistently across both frontend and backend services
- **SC-009**: Account activation completes within 10 seconds of the system receiving the verification link click (system processing time only; network and redirect latency excluded); account is immediately available for login
- **SC-010**: Concurrent sessions are fully independent; logout from one device does not affect other active sessions (100% session isolation)
- **SC-011**: Sessions automatically expire after 30 minutes of inactivity or 24 hours absolute timeout; 100% of expired sessions are redirected to login screen

## Assumptions

- Keycloak is deployed and accessible with the `movie-collection-manager` client configured in the `jumbleknot` realm
- Keycloak client roles `mc-admin` and `mc-user` are pre-configured before this feature is deployed
- The home screen functionality implementation (UI/navigation) is handled by a separate feature and is not included in this scope
- User registration and authentication will use standard email/password credentials via Keycloak
- Session tokens will be stored in a secure, JavaScript-inaccessible client-side store (with encrypted device storage as fallback for platforms with cookie restrictions)
- The network connection between MCM App, MCM BFF, and Keycloak is reliable; timeout handling will be documented in architecture constraints
- New users will always be assigned the `mc-user` role; no self-service role elevation is supported
- Profile page details refer to information retrievable from the JWT token and Keycloak user profile (username, email, first name, last name, roles, status)
- Keycloak is configured to support email sending for verification messages (SMTP settings configured)
- Password policy compliance will be enforced by Keycloak; the system will reject passwords that do not meet the specified requirements
- Email verification is performed through Keycloak's built-in email verification workflow
- Multiple concurrent sessions are supported; each device maintains an independent JWT token; logout from one device does not invalidate tokens on other devices

## Constraints

- Must follow all constraints and architecture patterns defined in [MCM-Architecture.md](../../docs/MCM-Architecture.md)
- Authentication must use Keycloak as the identity provider; no alternative authentication methods are supported
- **Session Management**: Sessions must automatically expire after 30 minutes of inactivity (idle timeout) or 24 hours from creation (absolute timeout), whichever comes first. Idle-timeout sessions redirect users to the login screen with message: "Your session has expired due to inactivity. Please log in again." Absolute-timeout sessions redirect with message: "Your session has expired. Please log in again."
- The home screen functionality is explicitly out of scope for this feature
- Navigation bar elements other than "Home" and "Profile" are out of scope
- Must integrate with the MCM BFF API layer for all authentication operations
- All protected endpoints must validate JWT token and role membership before granting access
