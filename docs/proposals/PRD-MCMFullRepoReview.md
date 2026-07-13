# Full-repo review — 10 findings

Ranked most-severe first. Local high-effort review (cloud `ultrareview` unavailable), scope = entire repository.

## 1. Stored XSS / unsafe URL open via movie External-ID URLs

[movie-detail.tsx:24](../frontend/mcm-app/src/components/movie-detail.tsx#L24) + [external_id.rs:14](../backend/mc-service/src/domain/external_id.rs#L14)

`openUrl` passes a user-supplied `externalIds[].url` straight to `window.open(url, …)` (web) / `Linking.openURL(url)` (native) with no scheme allowlist. The domain object derives `Deserialize` (line 6), so the wire path never runs `ExternalIdentifier::new`, and `url` is never validated for scheme anywhere.

**Scenario:** a user saves a movie with `url = "javascript:fetch('/bff-api/...')"` (web) or an arbitrary `myapp://`/intent scheme (native); tapping the link executes attacker script in the app origin / fires an arbitrary deep link.

## 2. IDOR + cross-tenant DuplicateMovie DoS — create-movie never checks collection ownership

[create_movie.rs:54](../backend/mc-service/src/application/commands/create_movie.rs#L54), repo [movie_repository.rs:166](../backend/mc-service/src/adapters/mongodb/movie_repository.rs#L166), index [indexes.rs:67](../backend/mc-service/src/adapters/mongodb/indexes.rs#L67)

`create()` stamps the caller's `ownerId` onto a movie under whatever `collectionId` was passed, with no check that the caller owns that collection. The unique index is `{collectionId, title, year, contentType}` — **no `ownerId`**.

**Scenario:** attacker (valid mc-user) POSTs a movie into a victim's `collectionId` (an ObjectId); reads are owner-scoped so the victim never sees it, but the row now occupies the uniqueness slot — the victim gets `E11000 → DuplicateMovie` when they try to add that same title/year, a silent cross-tenant denial. Same missing check in delete/update paths' assumption that `collectionId ⇒ single owner`.

## 3. Idle (30 min) and absolute (24 h) session timeouts are silently capped at 10 min

[cache-service.ts:18](../frontend/mcm-app/src/bff-server/cache-service.ts#L18)

`SESSION_TTL_SECONDS = 600` is the Redis TTL for every session write, but [session-manager.ts:65](../frontend/mcm-app/src/bff-server/session-manager.ts#L65) enforces idle against `env.sessionIdleTimeoutMs` (default 1,800,000 = 30 min) and absolute against 24 h.

**Scenario:** a user idle for 11 minutes finds their session already evicted from Redis → `getValidSession` returns null → forced re-login 19 minutes early. The configured idle/absolute policy is never the real timeout (10 min always wins).

## 4. Login rate-limit bypass and global lockout via X-Forwarded-For

[rate-limiter.ts:124](../frontend/mcm-app/src/bff-server/rate-limiter.ts#L124)

`extractClientIp` trusts the client-supplied `X-Forwarded-For` first hop with no trusted-proxy check, and returns the literal `'unknown'` when the header is absent.

**Scenario A (bypass):** attacker rotates `X-Forwarded-For` per request → each login uses a fresh Redis key → the 5/min cap never trips → unlimited brute force.
**Scenario B (DoS):** in any deployment not behind an XFF-setting proxy, all clients share key `'unknown'` → 5 failed logins lock out every user for 60 s.

## 5. `update()` destroys `createdAt` on every movie edit

[movie_repository.rs:315](../backend/mc-service/src/adapters/mongodb/movie_repository.rs#L315)

`replace_one` builds a full `MovieDao` with `created_at: DateTime::now()` (the code comment literally says "will be overwritten in a real impl with original").

**Scenario:** user edits any field via PUT → the original creation timestamp is permanently overwritten with the edit time; any "recently added" sort/audit is corrupted after the first edit.

## 6. Set-default clears the existing default before validating the target

[set_default_collection.rs:28](../backend/mc-service/src/application/commands/set_default_collection.rs#L28), caller [update.rs:28](../backend/mc-service/src/api/collections/update.rs#L28)

`handle` calls `clear_default_for_owner` first, then `set_as_default`.

**Scenario:** user PATCHes a stale/foreign/non-existent `collectionId` with `isDefault:true` → old default is cleared, `set_as_default` returns `CollectionNotFound` → user is left with **no** default. In `update.rs` the set-default runs before the name update, so a subsequent `DuplicateCollectionName` returns an error while the default has already silently changed (partial, non-transactional state).

## 7. `verify-email` treats any Keycloak 302 as success

[verify-email+api.ts:44](../frontend/mcm-app/src/app/bff-api/auth/verify-email+api.ts#L44)

`if (keycloakRes.status === 302 || keycloakRes.ok)` returns `{success:true, "Your email has been verified"}`. Keycloak's `login-actions/action-token` returns **302 on failure too** (redirect to its error page).

**Scenario:** a user clicks an expired/used/tampered link → Keycloak 302s to an error page → the BFF reports verification succeeded.

## 8. Registration rate-limited by email only — IP-based throttle missing

[register+api.ts:59](../frontend/mcm-app/src/app/bff-api/auth/register+api.ts#L59) (limiter [rate-limiter.ts:64](../frontend/mcm-app/src/bff-server/rate-limiter.ts#L64))

`extractClientIp` is called at line 29 but `ip` is used only in `logger.audit` (line 98); the only limit is `checkRegisterRateLimit(email)`.

**Scenario:** attacker scripts registrations with unique emails (`a+1@…`, `a+2@…`) from one IP → unlimited Keycloak Admin `createUser` calls + verification emails → account-spam / email-bomb / Admin-API DoS.

## 9. Unauthenticated session side-effects keyed on attacker-supplied `X-Session-Id`

[user+api.ts:30](../frontend/mcm-app/src/app/bff-api/auth/user+api.ts#L30), [logout+api.ts:33](../frontend/mcm-app/src/app/bff-api/auth/logout+api.ts#L33)

`user` runs `validateSessionTimeout(sessionId)` **before** `requireAuth`; `logout` swallows the `requireAuth` failure then proceeds to `terminateSession` + `logoutUserSessions(userId)` on the header-supplied session.

**Scenario:** an unauthenticated caller who learns a victim's session id (or a CSRF on the cookie) drives session-timeout mutation / a full forced logout of the victim's SSO sessions without ever proving identity.

## 10. BFF path params interpolated into the upstream mc-service URL without validation or encoding

[collections/[collectionId]/index+api.ts](../frontend/mcm-app/src/app/bff-api/collections/[collectionId]/index+api.ts) (and all sibling `[collectionId]`/`[movieId]` routes)

`collectionId`/`movieId` are concatenated raw into `/api/v1/collections/${collectionId}/…` with no format check (`ObjectId`/`UUID`) and no `encodeURIComponent`.

**Scenario:** a value containing `/`, `?`, or `%2f` injects extra path segments/query params into the upstream request (parameter smuggling against mc-service) and, at minimum, turns malformed ids into opaque upstream 500s instead of a clean 400 at the edge.

---

## Lower-severity confirmed items (cut for the 10-cap)

- Eviction TOCTOU can exceed `MAX_CONCURRENT_SESSIONS` under concurrent login — [session-manager.ts:31](../frontend/mcm-app/src/bff-server/session-manager.ts#L31)
- A garbage/tampered pagination `cursor` is silently ignored → restarts at page 1 instead of 400 — [movie_repository.rs:372](../backend/mc-service/src/adapters/mongodb/movie_repository.rs#L372)
- `evaluatePassword` returns `score` 0–5 while the type documents 0–4 — [validators.ts:74](../frontend/mcm-app/src/utils/validators.ts#L74)
- `getSession` does an uncaught `JSON.parse` on Redis values — [cache-service.ts:74](../frontend/mcm-app/src/bff-server/cache-service.ts#L74)
- Movie `title`/`language` have no non-empty validation.

## Refuted finder claim

- JWT algorithm-confusion — `createVerify` with an RSA PEM rejects `alg:none`/`HS256` (they throw → 401), so it's a hardening gap (no explicit allowlist), not an exploitable bypass — [token-service.ts:215](../frontend/mcm-app/src/bff-server/token-service.ts#L215)
