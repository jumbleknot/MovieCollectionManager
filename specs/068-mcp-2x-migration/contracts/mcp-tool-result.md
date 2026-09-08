# Contract: MCP tool result and per-call credentials across the 1.x → 2.x boundary

**Governs**: FR-014, FR-015, FR-016, FR-018, FR-019, FR-020

This is a **preservation** contract. Nothing here is new behaviour; it records what must still be
true after the SDK major changes underneath, so a reviewer can check the migration against something
other than "the tests still pass".

---

## 1. Tool result payload

A tool call returns three things the assistant consumes: an error flag, a structured payload, and
text content. The gateway folds them into its own result type; both server integration suites assert
against the same shape.

| what | 1.x field | 2.x field | behaviour |
|---|---|---|---|
| error flag | `isError` | `is_error` | unchanged |
| structured payload | `structuredContent` | `structured_content` | unchanged, **subject to §2** |
| text content | `content[].text` | `content[].text` | unchanged |
| tool descriptor schema | `inputSchema` | `input_schema` | unchanged |

**INV-1**: A tool declared to return a mapping yields that mapping as the structured payload.

**INV-2**: A tool declared to return a sequence yields it wrapped under a single `result` key. The
gateway's unwrap of exactly `{"result": ...}` and both suites' `_payload()` helpers therefore remain
correct and must not be "simplified" during the migration.

**INV-3**: A tool that fails against its upstream service surfaces a tool error carrying the upstream
status, not a transport-level exception.

**INV-4**: No call site anywhere under `agents/` or `mcp-servers/` reads a 1.x field name after the
migration. There are **14** such reads today; the count after is zero.

---

## 2. Tool return annotations are load-bearing

**INV-5**: Every `@mcp.tool()`-decorated function declares a return annotation that is **not** bare
`dict`, bare `list`, `Any`, or absent.

This is not style. On 2.x a bare `dict` annotation produces `structured_content: None` — measured —
so the assistant silently receives text only, with no test failing and no error logged. The precise
annotations in use (`dict[str, Any]`, `list[dict[str, Any]]`) behave identically to 1.x.

All 15 tools comply today (9 `movie-mcp`, 4 `spreadsheet-mcp`, 2 `web-api-mcp`). The guard exists to
keep it that way, and must AST-parse rather than regex — a decorator and its function signature may
span lines, and a regex over `@mcp.tool()` followed by `def` misses multi-line parameter lists.

---

## 3. Per-call credentials

The gateway attaches two independent credentials to an outbound MCP request, each read from a
ContextVar set synchronously immediately before the call, in the same coroutine.

| credential | header | set for | omitted when |
|---|---|---|---|
| downscoped backend token | `Authorization: Bearer <token>` | movie server calls | its ContextVar is unset |
| per-run external API key | `X-TMDB-Key: <key>` | external-API server calls | its ContextVar is unset |

**INV-6**: The two are independent. A call to the external-API server carries **no** bearer; a call to
the movie server carries **no** API key. Neither is defaulted, inherited, or carried over between
calls.

**INV-7**: Neither credential is written to checkpointed agent state, traces, or logs. This is the
constitution's Identity Propagation rule and is non-negotiable.

**INV-8**: Any HTTP client the gateway constructs for a call is released when the call completes, on
**both** the success and the failure path. This invariant is new in substance: on 1.x the transport
owned the client, so there was nothing for the caller to leak. On 2.x the caller supplies it, and a
leaked client holds a credential-bearing auth object alive.

**INV-9**: The credential is injected by the auth object's request hook, not by mutating a shared
client's default headers — otherwise a client reused across calls would carry the previous call's
credential.

---

## 4. Transport posture of the three servers

**INV-10**: DNS-rebinding host validation stays **disabled**, so a request addressed to a Docker
service name (`movie-mcp:8000`) is served rather than rejected with a host mismatch. The
configuration point moves; the posture does not change in either direction.

**INV-11**: The servers stay stateless with JSON responses.

**INV-12**: The uvicorn bind address remains each server's own environment variable (`MC_MCP_HOST`
and its siblings). The SDK's `host` parameter is **not** a bind address — it is the trigger for an
auto-enable branch that is skipped whenever transport security is passed explicitly, which these
servers do. It must not be set in a way that implies otherwise.
