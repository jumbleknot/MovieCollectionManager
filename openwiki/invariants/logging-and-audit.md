---
type: Convention
title: Logging and audit conventions
description: The structured-logging and security-audit-event requirements shared across the BFF, mc-service, and Agent Gateway, including the never-log list and each layer's redaction mechanism.
resource: CLAUDE.md
tags: [logging, audit, security, redaction]
timestamp: 2026-07-28T02:22:54.286Z
---

# Logging and audit conventions

Every layer of the stack logs structurally (never plain `console.*`/`println!`/bare `print`) and
every layer maintains its own never-log list plus an automated or manual redaction mechanism —
because a token or credential that reaches a log line is effectively leaked to log storage and any
downstream shipper.

- **BFF** (`src/bff-server/logger`): outputs newline-delimited JSON, automatically redacts fields
  named `token`, `sessionId`, `password`, `secret`, `cookie`, `authorization`, `code`,
  `codeVerifier`, `email`, `username`. `logger.audit(...)` is the dedicated call for
  security-relevant events (login success/failure, logout, registration, 403, 401, 429 rate-limit
  hits), and every entry must carry a `requestId` correlation ID propagated via `AsyncLocalStorage`.
- **mc-service** (`tracing` crate, JSON subscriber): correlation via a per-request `request_id` span
  field that all child spans inherit automatically; `RUST_LOG` scopes verbosity per-crate to avoid
  dependency log flooding.
- **Agent Gateway** (`audit_sink.py`): always logs via the module logger; when `OPENSEARCH_URL` is
  set, additionally fire-and-forgets an audit document to the append-only `mcm-agent-audit` index
  with a bounded 3-second timeout — audit is deliberately never-blocking and never-raising toward
  the calling tool path.

## Gotchas

- **Never log, anywhere in the stack**: raw tokens, session IDs, passwords, email addresses,
  usernames, JWT payloads, or partial auth codes. Log the Keycloak user ID (UUID) for
  ownership/audit purposes instead — never the username or email.
- **The Agent Gateway's redaction is a static AST scan, not just a runtime allowlist.** The token-leak
  scan (`src/eval/token_leak_scan.py`) walks the agent + MCP source for any logging/print call that
  passes a token-*named variable* as a value — it catches a regression on any log site whether or
  not that code path is exercised by a test, which a runtime-only check cannot. String literals
  merely containing the word "token" are not flagged; only logged token-named variables are.
  `build_audit_doc` strips the same marker set before both the log line and the OpenSearch POST.
- **The BFF's audit fields are pending full correlation-ID wiring** (marked pending in `CLAUDE.md` at
  time of writing) — do not assume every audit call site already carries a `requestId` without
  checking the current source.
- **`debug` severity must be suppressed in production** (`NODE_ENV=production`); `warn`/`error` write
  to stderr, everything else to stdout — a log shipper or dashboard that doesn't split streams will
  silently miss this distinction.
- **Log retention is 30 days general / 90 days audit**, enforced via Docker log rotation
  configuration, not a separate retention service — long-term retention requires a log shipper that
  does not exist in this stack yet.
- **This is a different mechanism from the append-only audit sink pattern** described in
  [Secrets management](/openwiki/invariants/secrets-management.md)'s references to the audit stack —
  logging redaction protects what reaches storage, while the [auth chain](/openwiki/invariants/auth-chain.md)'s
  audit events are what's *supposed* to reach storage, minus anything on the never-log list.

Full field-by-field logger API and RUST_LOG examples: `CLAUDE.md`'s Logging section.
