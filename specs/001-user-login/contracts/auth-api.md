# Auth API Contract Documentation

All BFF auth endpoints are served at `/bff-api/auth/*` via Expo Router API Routes.

## Base URL

Development: `http://localhost:8081/bff-api/auth`

---

## Endpoints

### POST /register

Register a new user account. Keycloak Admin API creates the user with `mc-user` role.

**Rate limit**: 10 requests / email / day

**Request body**:
```json
{
  "username": "string (3-20 chars, alphanumeric + underscore)",
  "email": "string (valid RFC 5322 email)",
  "firstName": "string (1-50 chars)",
  "lastName": "string (1-50 chars)",
  "password": "string (12+ chars, uppercase, lowercase, digit, special char)"
}
```

**Response 201**:
```json
{
  "success": true,
  "message": "Account created. Please verify your email.",
  "userId": "string (Keycloak UUID)"
}
```

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_INPUT` | Missing required fields |
| 400 | `INVALID_EMAIL` | Email format invalid |
| 400 | `WEAK_PASSWORD` | Password policy not met |
| 400 | `INVALID_USERNAME` | Username format invalid |
| 409 | `DUPLICATE_EMAIL` | Email already registered |
| 409 | `DUPLICATE_USERNAME` | Username already taken |
| 429 | `RATE_LIMIT_EXCEEDED` | Too many registration attempts |

---

### POST /login

Exchange PKCE authorization code for JWT tokens. Validates ID token, enforces session limits.

**Rate limit**: 5 requests / IP / minute

**Request body**:
```json
{
  "code": "string (authorization code from Keycloak)",
  "codeVerifier": "string (PKCE S256 code verifier)",
  "redirectUri": "string (must match Keycloak client configuration)"
}
```

**Response 200** (sets HTTP-only cookies):
```json
{
  "success": true,
  "user": {
    "id": "string",
    "username": "string",
    "email": "string",
    "firstName": "string",
    "lastName": "string",
    "roles": ["mc-user"],
    "emailVerified": true
  }
}
```

Cookies set: `mcm_access_token`, `mcm_refresh_token`, `mcm_session_id` (all HttpOnly, SameSite=Strict, Secure)

Response headers: `X-Session-Id: <sessionId>`

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_INPUT` | Missing code/codeVerifier/redirectUri |
| 401 | `TOKEN_EXPIRED` | ID token expired |
| 401 | `TOKEN_INVALID` | ID token at_hash validation failed |
| 403 | `FORBIDDEN` | Account lacks required role |
| 403 | `ACCOUNT_DISABLED` | Account disabled in Keycloak |
| 403 | `ACCOUNT_LOCKED` | Account locked due to failed attempts |
| 429 | `RATE_LIMIT_EXCEEDED` | Too many login attempts |

---

### POST /refresh

Exchange a refresh token for a new access token. Rate-limited per session.

**Rate limit**: 2 retries / 30 seconds / session

**Cookies required**: `mcm_refresh_token`, `mcm_session_id`

**Request body**: (empty)

**Response 200**:
```json
{
  "success": true,
  "expiresIn": 900
}
```

Sets new `mcm_access_token` and `mcm_refresh_token` cookies.

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 401 | `SESSION_NOT_FOUND` | No session ID in request |
| 401 | `SESSION_EXPIRED` | Session idle/absolute timeout |
| 401 | `REFRESH_TOKEN_INVALID` | No refresh token cookie |
| 429 | `RATE_LIMIT_EXCEEDED` | Too many refresh attempts |

---

### GET /user

Returns the authenticated user's profile. Redis-cached (5-min TTL).

**Cookies required**: `mcm_access_token` or `Authorization: Bearer <token>`

**Response 200**:
```json
{
  "id": "string",
  "username": "string",
  "email": "string",
  "firstName": "string",
  "lastName": "string",
  "roles": ["mc-user"],
  "emailVerified": true
}
```

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 401 | `UNAUTHORIZED` | No valid JWT |
| 401 | `TOKEN_EXPIRED` | JWT expired |
| 403 | `FORBIDDEN` | Lacks mc-user or mc-admin role |

---

### POST /logout

Terminates the current session only. Revokes refresh token in Keycloak. Clears auth cookies.

**Cookies required**: `mcm_session_id`, `mcm_refresh_token`

**Request body**: (empty)

**Response 200**:
```json
{
  "success": true,
  "message": "Logged out successfully."
}
```

Clears cookies: `mcm_access_token`, `mcm_refresh_token`, `mcm_session_id` (Max-Age=0)

---

### POST /register → GET /verify-email

**Verify email** (token from Keycloak email link):

`GET /verify-email?token=<verification-token>`

**Response 200**:
```json
{
  "success": true,
  "message": "Email verified successfully."
}
```

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 400 | `VERIFICATION_TOKEN_INVALID` | Missing or malformed token |
| 400 | `VERIFICATION_TOKEN_EXPIRED` | Token expired or invalid |

---

### POST /resend-verification

Resend email verification link.

**Rate limit**: 3 requests / email / hour

**Request body**:
```json
{ "email": "string" }
```

**Response 200** (always, even if email not found — prevents enumeration):
```json
{
  "success": true,
  "message": "Verification email sent."
}
```

**Error responses**:

| Status | Code | Description |
|--------|------|-------------|
| 400 | `INVALID_EMAIL` | Email format invalid |
| 429 | `RATE_LIMIT_EXCEEDED` | Too many resend attempts |

---

## Error Response Shape

All error responses follow this shape:
```json
{
  "error": "Human-readable message",
  "code": "MACHINE_READABLE_CODE",
  "retryAfter": 60  // optional, seconds until retry allowed (rate limit responses)
}
```

## Rate Limit Headers

When rate limited, the response includes:
```
Retry-After: <seconds>
```

## Cookie Configuration

| Cookie | HttpOnly | SameSite | Secure | Max-Age |
|--------|----------|----------|--------|---------|
| `mcm_access_token` | ✓ | Strict | ✓ | 900 (15 min) |
| `mcm_refresh_token` | ✓ | Strict | ✓ | 604800 (7 days) |
| `mcm_session_id` | ✓ | Strict | ✓ | 604800 (7 days) |

## Session Limits

- Maximum 10 concurrent sessions per user
- Oldest inactive session evicted when limit reached
- Idle timeout: 30 minutes
- Absolute timeout: 24 hours
