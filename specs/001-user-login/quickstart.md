# Quickstart: User Login & Registration Feature

**Feature**: 001-user-login  
**Stack**: React Native + Expo, Expo Router BFF, Keycloak, Redis

---

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | ≥ 22 | Use nvm/fnm for version management |
| Expo CLI | Latest | `npm install -g expo-cli` |
| Docker Desktop | Latest | For Keycloak + Redis |
| Android Studio | Ladybug+ | For Android emulator (Pixel 6, API 34) |

---

## 1. Start Infrastructure

```bash
# Start Keycloak (port 8099) from repo root
cd infrastructure-as-code/docker/keycloak
docker compose -f compose.yaml up -d

# Verify Keycloak is healthy
curl -f http://localhost:8099/realms/master || echo "Keycloak not ready yet"

# Start Redis (port 6379) for BFF cache
docker run -d --name mcm-redis -p 6379:6379 redis:8.6.2-alpine3.23
```

---

## 2. Configure Keycloak (T-009 through T-013) — Manual Steps

> These steps require one-time configuration in the Keycloak Admin Console.  
> Open: http://localhost:8099 → Admin Console → Login with admin credentials.

### 2a. Configure Realm (T-009)

1. Verify realm **`jumbleknot`** exists (or create it)
2. Enforce PKCE via Client Policies:
   - Navigate to **Realm settings → Client policies tab**
   - Click Client Profiles tab → Create client profile
   - Name it e.g. pkce-profile
   - Click Save
   - Click Add executor → select Proof Key for Code Exchange Enforcer
   - Set Auot-configure On (ensures Code Challenge Method to S256)
   - Click Save
   - Click Client Policies tab → Create client policy
   - Name it e.g. pkce-policy
   - Click Save
   - Under Conditions, click Add condition → select Client Access Type
   - Set access type to confidential (or use Client Roles / Client Scopes to target just this client) and click Add
   - Under Client Profiles, click Add client profile → select pkce-profile → click Add

### 2b. Configure Client (T-009)

1. Navigate to **Clients → `movie-collection-manager`**
2. Verify settings:
   - **Client Authentication**: On (BFF is confidential client)
   - **Authorization**: Off
   - **Authentication flow - Standard Flow**: Enabled ✅
   - **Authentication flow - all others**: Disabled ❌
   - **PKCE Method**: S256

### 2c. Configure Redirect URIs (T-009a)

In **Clients → `movie-collection-manager` → Settings**:

| Field | Value |
|-------|-------|
| Valid Redirect URIs | `exp://localhost:8081/--/bff-api/auth/callback` |
| Valid Redirect URIs | `mcm-app://bff-api/auth/callback` |
| Web Origins | `http://localhost:8081` |
| Post Logout Redirect URIs | `exp://localhost:8081/--/` |

### 2d. Configure Client Roles (T-010)

1. Navigate to **Clients → `movie-collection-manager` → Roles**
2. Create role: **`mc-user`** (Standard user)
3. Create role: **`mc-admin`** (Administrator)

### 2e. Configure SMTP (T-011)

1. Navigate to **Realm Settings → Email**
2. Fill in your SMTP server settings:
   - **Host**: `smtp.your-provider.com`
   - **Port**: `587`
   - **From**: `noreply@yourdomain.com`
   - **Enable StartTLS**: Yes
   - **Username** / **Password**: Your SMTP credentials
3. Click **Test Connection** to verify

### 2f. Configure Password Policy (T-012)

1. Navigate to **Admin Console → realm: jumbleknot → Authentication → Password Policy**
2. Add the following policies:
   - **Minimum Length**: 12
   - **Upper Case**: 1
   - **Lower Case**: 1
   - **Digits**: 1
   - **Special Characters**: 1

### 2g. Email Verification Timeout (T-013)

1. Navigate to **Realm Settings → Tokens**
2. Set **Email Verification Token** = `1 day` (24 hours)

### 2h. Create BFF Service Account Client (T-009b)

The BFF uses a dedicated confidential client with a service account to call the Keycloak Admin API. This replaces the admin username/password approach and limits the blast radius to only the permissions the BFF actually needs.

1. Navigate to **Clients → Create client**
2. Set **Client ID**: `mcm-bff-service`
3. Set **Client authentication**: On (confidential client)
4. Set **Authentication flow**: uncheck all except **Service accounts roles** ✅
5. Click **Save**
6. Navigate to **Clients → mcm-bff-service → Service account roles**
7. Click **Assign role** → **Client roles** → filter by **realm-management** client
8. Assign these roles:
   - `manage-users` — create users, assign roles, delete unverified accounts
   - `view-users` — look up users by email and ID
   - `manage-clients` — update client redirect URIs at startup (used by `/init`)
9. Navigate to **Clients → mcm-bff-service → Credentials**
10. Copy the **Client secret** — you will need it in step 3

---

## 3. Configure Environment Variables

```bash
cd frontend/mcm-app

# Copy example env file
cp .env.example .env.local

# Edit .env.local with your values:
# KEYCLOAK_CLIENT_SECRET — copy from Keycloak → Clients → movie-collection-manager → Credentials
# KEYCLOAK_SERVICE_CLIENT_SECRET — copy from Keycloak → Clients → mcm-bff-service → Credentials
# COOKIE_SECRET — generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 4. Install Dependencies

```bash
cd frontend/mcm-app
npm install
```

---

## 5. Run the App (Development)

```bash
cd frontend/mcm-app

# Start Expo dev server
npx expo start

# In a separate terminal, run on Android emulator
npx expo start --android

# Or run in browser
npx expo start --web
```

---

## 6. Run Tests

```bash
cd frontend/mcm-app

# Unit + Integration tests
npm test

# With coverage report
npm run test:coverage

# Integration tests only
npm run test:integration

# E2E tests (requires running emulator + app built)
npm run test:e2e
```

---

## 7. Verify the Auth Flow

### Registration Flow
1. Open the app → tap **"Create Account"**
2. Fill in the registration form (username, email, password, names)
3. Submit → verify you receive a verification email
4. Click the verification link → confirm email is marked verified in Keycloak

### Login Flow
1. Tap **"Login with Keycloak"**
2. Keycloak hosted login page opens
3. Enter credentials → authenticate
4. App redirects back and displays the home screen

### Access Control
1. Log in as a user with **`mc-user`** role
2. Verify profile endpoint returns user data
3. Verify admin endpoints return 403 for non-admin users

---

## 8. Troubleshooting

| Problem | Solution |
|---------|----------|
| `KEYCLOAK_UNAVAILABLE` error | Verify `docker compose up -d` in keycloak/ folder; check port 8099 |
| Redirect URI mismatch | Verify Keycloak client has `exp://localhost:8081/--/bff-api/auth/callback` in Valid Redirect URIs |
| Email not received | Check SMTP settings in Keycloak → Realm Settings → Email |
| Redis connection refused | Ensure Redis container is running: `docker ps \| grep redis` |
| JWT validation failure | Verify `KEYCLOAK_REALM` and `KEYCLOAK_URL` match your Keycloak setup |
| 429 Too Many Requests | Rate limit hit — wait before retrying; see rate limits in plan.md |
| Admin API 401/403 errors | Verify `mcm-bff-service` client exists in `jumbleknot` realm with service accounts enabled and `manage-users`, `view-users`, `manage-clients` roles assigned; verify `KEYCLOAK_SERVICE_CLIENT_SECRET` is set |

---

## 9. Load Testing (optional — k6 required)

```bash
# Install k6: https://k6.io/docs/get-started/installation/
# Then run with a running local stack:
k6 run --env BASE_URL=http://localhost:8081 tests/load/auth-load-impl.ts
```

Thresholds (SC-007): 99.5% success rate, p95 login < 5s, p95 profile < 2s.

---

## Architecture Reference

- **Spec**: [spec.md](spec.md)  
- **Plan**: [plan.md](plan.md)  
- **Tasks**: [tasks.md](tasks.md)  
- **API Contracts**: [contracts/auth-api.md](contracts/auth-api.md)  
- **Data Model**: [data-model.md](data-model.md)  
- **Integration Guide**: [integration-guide.md](integration-guide.md)  
- **Architecture**: [docs/MCM-Architecture.md](../../docs/MCM-Architecture.md)

### Auth Flow Summary

```
App                        BFF (/bff-api/auth)        Keycloak
 |                              |                          |
 |-- "Login with Keycloak" -->  |                          |
 |   (expo-auth-session PKCE)   |                          |
 |                              |                          |
 |<-- Redirect to Keycloak ---- |                          |
 |                              |                          |
 |------- User authenticates on Keycloak login page -----> |
 |                              |                          |
 |<-- Auth code returned -------------------------------------------
 |                              |                          |
 |-- POST /bff-api/auth/login -->                          |
 |   {code, codeVerifier,       |                          |
 |    redirectUri}              |                          |
 |                              |-- Token exchange ------> |
 |                              |<-- access+refresh token- |
 |                              |                          |
 |                              |-- Validate ID token      |
 |                              |   (iss, aud, exp, at_hash)|
 |                              |                          |
 |                              |-- Set HTTP-only cookie   |
 |<-- 200 OK + Set-Cookie ----- |                          |
 |   (JWT in secure cookie)     |                          |
 |                              |                          |
 |-- Navigate to home screen    |                          |
```

### Registration Flow Summary (Option A)

```
App (Registration Form)    BFF (/bff-api/auth)        Keycloak Admin API
 |                              |                          |
 |-- "Create Account" tap -->   |                          |
 |   (app-side form)            |                          |
 |                              |                          |
 |-- Fill form + submit -------> |                          |
 |   POST /bff-api/auth/register|                          |
 |   {username, email,          |                          |
 |    password, names}          |                          |
 |                              |-- Rate limit check       |
 |                              |-- Validate password      |
 |                              |-- POST /admin/realms/.../users
 |                              |   (create user)      --> |
 |                              |<-- 201 Created ----------|
 |                              |-- Assign mc-user role    |
 |                              |-- Trigger verification email
 |<-- 201 + "Check your email"--|                          |
```
