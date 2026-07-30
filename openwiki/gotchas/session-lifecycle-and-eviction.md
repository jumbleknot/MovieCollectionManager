---
type: Gotcha
title: Session ID vs JWT — Redis session lifecycle and concurrent-session eviction
description: Redis-backed BFF sessions track idle/absolute timeout and a per-user concurrent-session cap independently of the Keycloak JWT lifetime; session-manager.ts evicts the oldest session once a user exceeds MAX_CONCURRENT_SESSIONS, and the client only ever holds the session ID, never a token.
resource: frontend/mcm-app/src/bff-server/session-manager.ts
tags: [auth, sessions, redis, bff, keycloak]
timestamp: 2026-07-30T11:50:53-04:00
---

# Session ID vs JWT — Redis session lifecycle and concurrent-session eviction

The BFF's Redis session (`session-manager.ts`) and the underlying Keycloak JWT are two separate
lifecycles. The session tracks its own idle timeout and absolute timeout independently of however
long the JWT itself is valid for, and it additionally enforces a per-user cap on concurrent sessions
(`MAX_CONCURRENT_SESSIONS`) that has nothing to do with token expiry. See
[the auth chain](/openwiki/invariants/auth-chain.md) for where this session sits in the full
login-to-request sequence.

## Gotchas

- **Session ID vs JWT**: Redis session tracks timeout and concurrent session limits independently of
  the JWT lifetime.
- **Concurrent session eviction**: when a user exceeds `MAX_CONCURRENT_SESSIONS`, `session-manager.ts`
  evicts the oldest session automatically.
- **The client stores only the session ID, not tokens.** The React Native client never touches raw
  JWTs — the BFF owns all token handling server-side, and only the opaque Redis session ID is
  persisted client-side (in a cookie).
- **Eviction has a documented TOCTOU race under simultaneous logins.** `createSession()` checks the
  session count before adding the new session, then re-checks and trims after adding — this two-step
  pre/post-check exists specifically because the pre-add check alone is racy under concurrent logins
  (feature 009 FR-018). The post-add trim loop breaks out on "no progress" to avoid spinning forever
  against stale set members whose session objects are already gone.
