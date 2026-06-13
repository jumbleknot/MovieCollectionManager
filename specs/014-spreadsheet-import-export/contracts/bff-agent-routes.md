# Contract: New BFF Agent Routes + Supervisor Intents

All routes are under the existing protected agent area; they terminate the session, enforce auth (`requireAuth` + `requireMcUser`), propagate identity into the run, and join the `AGENT_ROUTES` allowlist + `route-coverage-map`. They are a secure proxy + transient-file broker only — no domain logic, no event translation (constitution: BFF as secure proxy).

## Route: `POST /bff-api/agent/import-upload`

Accept the user-selected file, stash it in the transient store, return a handle for the agent run.

- **Request**: `multipart/form-data` with one file part (CSV or `.xlsx`). Server-side validation: content type, extension, size guard.
- **Response 200**: `{ "fileHandle": "string", "filename": "string", "kind": "csv" | "xlsx", "sizeBytes": number }`
- **Errors** (RFC 9457): `400` unsupported/empty/oversize file; `401`/`403` auth; `500` store failure.
- **Security**: file bytes written to the short-TTL transient store keyed by `fileHandle` (plan R3); **never logged**; audit event records the action + user + filename (not contents). The handle is passed as a run input to the `import` flow; bytes are fetched only by `spreadsheet-mcp`.

## Route: `GET /bff-api/agent/export-download?handle=<downloadHandle>`

Stream a generated export workbook to the client so the browser downloads it.

- **Request**: `handle` query param (the `downloadHandle` from `build_workbook`, surfaced to the client by the export node via an AG-UI action).
- **Response 200**: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` stream with `Content-Disposition: attachment; filename="..."`.
- **Errors**: `400` missing/invalid handle; `404` expired/unknown handle; `401`/`403` auth. The handle is scoped to the requesting user (ownership-checked like agent thread ownership).
- **Security**: handle is unguessable + short-TTL + single-use; download is audit-logged.

## Reused UI-action authorisation

The export "trigger download" and import "open file picker / show preview" are AG-UI client instructions; they dispatch through the existing UI-action authorisation path (client POSTs `{type,target}`; BFF authorises against JWT roles; unknown → discard). New action types join the allowlist.

## Supervisor intents (classify_intent)

Two new intents added to the supervisor prompt (plan R9). Re-record golden cassettes after this change; verify on qwen2.5 (runtime) and Claude (gate).

| Intent | Triggers (examples) | Routes to | Notes |
|---|---|---|---|
| `import` | "import this spreadsheet", "load my movies from this file", "bring in my collection from Excel" | `import_collection` node | Distinguish from `add` (single movie) and `search`. |
| `export` | "export my collections to a spreadsheet", "download my movies as Excel", "give me a spreadsheet of <collection>" | `export_collection` node | Distinguish from `query`/`list` (on-screen answer, not a file). |

## Reused MCP tools (movie-mcp) — no contract change

`list_collections` (tab→collection match + export selection), `list_movies` (dedup reads + export reads), `create_movie` (new), `update_movie` (existing, compose-then-replace). These already exist (012/013); import/export adds no new movie-mcp tools.
