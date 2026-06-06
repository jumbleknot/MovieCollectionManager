# Contract: Agent Gateway BFF Routes (secure proxy)

**Feature**: `012-multi-agent-mvp` | New routes under `frontend/mcm-app/src/app/bff-api/agent/`. OpenAPI source of truth: `api-specs/agent-bff-api.yaml` (spec-first).

These routes are a **secure proxy + AG-UI passthrough**. They MUST NOT transform AG-UI event shapes (constitution: BFF is proxy, not translator). Responsibilities: terminate the client session, mint/supply the **run-scoped subject token**, sanitize readable UI state, authorize UI actions, map `userId → threadId`, enforce per-user rate/cost limits.

> **VALIDATED + CORRECTED (T029, 2026-06-06):** the gateway (`ag_ui_langgraph`) emits **standard AG-UI events natively** over HTTP (`RUN_STARTED`, `STEP_*`, `TEXT_MESSAGE_*`, `STATE_SNAPSHOT`) — confirmed against a live gateway. **However**, the `@copilotkit/react-native` client connects to a CopilotKit **runtime** endpoint (`runtimeUrl` + `credentials:"include"`), not a raw AG-UI endpoint. So `run+api.ts` must host the CopilotKit runtime (`@copilotkit/runtime` `CopilotRuntime` + `LangGraphHttpAgent({ url: <gateway> })`) — the framework's **standard library bridge** (NOT bespoke per-event translation, which is what the constitution prohibits). The earlier "raw passthrough" note is superseded. The auth gate (T028a) is unchanged and proven. See research R6.

Auth pattern (consistent with existing BFF routes): `requireAuth(headers)` → `requireMcUser(user)` → proceed. Errors via the existing typed error handler. Audit via `logger.audit`.

---

## POST `/bff-api/agent/run`

Start or continue a conversation turn. Streams the agent's AG-UI events back to the client.

**Request** (JSON):
```jsonc
{
  "message": "Add the original Blade Runner to my Sci-Fi collection",  // user turn (guardrailed)
  "threadId": "uuid | null",        // null → BFF creates one and maps userId→threadId
  "uiState": {                       // optional; sanitized again at BFF before forward
    "currentScreen": "collection",
    "collectionId": "…",
    "movieId": null,
    "activeFilterKeys": ["genre"],
    "navDepth": 2
  }
}
```

**Behavior**:
1. `requireAuth` + `requireMcUser`; 401/403 exactly as the direct API (no info leak) — FR-010/011.
2. Enforce per-user request rate limit + session cost ceiling; if exceeded → `429`-style AG-UI "try again later", **no run started** (FR-020a, SC-011).
3. Sanitize `uiState` against the structural allowlist (drop non-allowlisted / value-bearing fields) — sole sanitization point.
4. Mint a **run-scoped subject token** (RFC 8693, audience-narrowed, agent-origin marker, short TTL) and pass it to the gateway as an **ephemeral run value** — never logged/checkpointed.
5. Open the gateway run and **proxy the AG-UI stream** (SSE/WebSocket) unchanged to the client.

**Response**: `text/event-stream` (or WS) of native AG-UI events: text deltas, `render_*` generative-UI events, `navigate_*`/`prefill_*` UI-action events (post-authorization), and `approval-request` events when a write is proposed.

**Errors**: `401` unauthenticated, `403` not mc-user, `429` rate/cost exceeded, `503` gateway/provider unavailable → AG-UI "couldn't complete" (FR-018). Never exposes internals.

---

## POST `/bff-api/agent/resume`

Resume an interrupted run after a HITL decision. **This is the approval authorization point** (in-session, no step-up — clarify round 1).

**Request**:
```jsonc
{
  "threadId": "uuid",
  "proposalId": "uuid",
  "decision": "approved | rejected"
}
```

**Behavior**:
1. `requireAuth` + `requireMcUser`; in-session is sufficient authorization (FR-006a). If the session has lapsed → `401`, client re-authenticates first.
2. Mint a **fresh** run-scoped subject token (paused run held none).
3. Resume the checkpoint: on `approved`, the gateway re-validates + applies writes (idempotency keys); on `rejected`, discards.
4. Record an **ApprovalDecision** to the OpenSearch audit stream (`userId`, `proposalId`, decision, applied/skipped item ids, `requestId`) — SC-002.
5. Proxy the continuation AG-UI stream (confirmation, per-item applied/skipped report, inline render).

**Errors**: `401`/`403` as above; `404` if thread/proposal unknown or already resolved/expired; `409` not exposed to client as internals — surfaced as a friendly "this proposal is no longer valid" (e.g., session expired → proposal expired, FR-008).

---

## POST `/bff-api/agent/ui-state`

Optional standalone push of a sanitized readable UI-state snapshot (when the user navigates without sending a turn), so "add this" resolves the current target (US3).

**Request**: `UiStateSnapshot` (structural allowlist only).
**Behavior**: `requireAuth`; sanitize; update the active thread's `ui_snapshot` via the gateway. **No** user-entered values or PII forwarded.
**Response**: `204 No Content`.

---

## UI-action authorization (applies to all emitted `navigate_*` actions)

Before the BFF forwards any agent-driven UI action to the client, it MUST verify the target (e.g., destination screen) is permitted for the user's current JWT roles. Unknown/unauthorized actions are **logged to audit and discarded** — never dispatched (constitution UI-Action Authorisation). An agent must never drive a user to a screen/operation they cannot access.

## Invariants (all routes)

- The gateway and `agent-db` are **never** reachable from the client — only from these BFF routes over the private network.
- No raw token (subject/exchanged) is ever returned to the client, logged, or checkpointed (SC-004).
- AG-UI event shapes are passed through unchanged (no translation).
- Every tool call / UI action / approval is audited with `userId`/`threadId`/`requestId`, never PII or tokens.
