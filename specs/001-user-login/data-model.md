# Data Model — User Login Feature

## Keycloak Entities

### KeycloakUser

Stored in Keycloak realm `grumpyrobot`.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Keycloak-generated user ID |
| `username` | string | Unique username (3–20 chars, alphanumeric + `_`) |
| `email` | string | RFC 5322 email address |
| `firstName` | string | Given name (1–50 chars) |
| `lastName` | string | Family name (1–50 chars) |
| `emailVerified` | boolean | Set to `true` after clicking verification link |
| `enabled` | boolean | `false` = account disabled (admin action) |
| `credentials` | array | Hashed password managed by Keycloak |
| `realmRoles` | string[] | Realm-level roles |
| `clientRoles` | Record | Client-specific roles: `{ "movie-collection-manager": ["mc-user"] }` |

### ClientRole Enum

```typescript
enum ClientRole {
  MCAdmin = 'mc-admin',
  MCUser = 'mc-user',
}
```

- `mc-admin` — full access including admin operations
- `mc-user` — standard authenticated user access
- `mc-admin` implicitly has `mc-user` access (checked in `role-check.ts`)

---

## JWT Token

### Access Token (JWTPayload)

Issued by Keycloak, validated by BFF `token-service.ts`.

| Claim | Type | Description |
|-------|------|-------------|
| `sub` | string | Keycloak user ID |
| `iss` | string | Keycloak issuer URL |
| `aud` | string/string[] | Client ID audience |
| `exp` | number | Expiration (Unix timestamp, 15-min lifetime) |
| `iat` | number | Issued at (Unix timestamp) |
| `at_hash` | string | Access token hash (ID token validation) |
| `realm_access.roles` | string[] | Realm-level roles |
| `resource_access["movie-collection-manager"].roles` | string[] | Client-level roles |
| `email` | string | User email |
| `email_verified` | boolean | Email verification status |
| `preferred_username` | string | Username |
| `given_name` | string | First name |
| `family_name` | string | Last name |

**Lifetime**: 15 minutes (access), 7 days (refresh)

---

## Redis Cache Entities

### Session

Stored at key `session:{sessionId}` with 10-minute TTL.

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | Keycloak user ID |
| `createdAt` | number | Unix timestamp of session creation |
| `lastActivity` | number | Unix timestamp of last request |

Session index stored at `user_sessions:{userId}` (Redis Set of session IDs).

### UserProfile Cache

Stored at key `user_profile:{userId}` with 5-minute TTL.

```typescript
interface UserProfile {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
  emailVerified: boolean;
}
```

### Rate Limit Counters

| Key Pattern | TTL | Description |
|-------------|-----|-------------|
| `rate_limit:register:{email}` | 86400s | Registration attempts per email/day (max 10) |
| `rate_limit:login:{ip}` | 60s | Login attempts per IP/min (max 5) |
| `rate_limit:refresh:{sessionId}` | 30s | Refresh attempts per session (max 2) |
| `rate_limit:resend:{email}` | 3600s | Resend verification per email/hour (max 3) |

---

## Auth State (Frontend)

### AuthState

```typescript
interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  user: UserProfile | null;
}
```

### Session Storage

| Platform | Storage | Keys |
|----------|---------|------|
| Web | HTTP-only cookies (server-managed) | `mcm_access_token`, `mcm_refresh_token`, `mcm_session_id` |
| Android/iOS | expo-secure-store (fallback) | `mcm_access_token`, `mcm_session_id` |

---

## Keycloak Realm Configuration

- **Realm**: `grumpyrobot`
- **Client ID**: `movie-collection-manager`
- **Client Type**: Confidential (has client secret)
- **Grant Types**: Authorization Code + PKCE
- **Redirect URIs**:
  - Development: `exp://localhost:8081/--/bff-api/auth/callback`
  - Production: `mcm-app://bff-api/auth/callback`
- **Access Token Lifetime**: 900s (15 min)
- **Refresh Token Lifetime**: 604800s (7 days)
- **PKCE Code Challenge Method**: S256
