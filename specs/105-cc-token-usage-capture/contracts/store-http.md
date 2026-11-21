# Contract: the store's HTTP interface

PostgREST over the `usage` schema (research R10). Base URL = `MCM_USAGE_INGEST_URL`. Every request
carries `Authorization: Bearer <access token>`, a Keycloak token for client `dev-usage-capture`
obtained and cached as below; its `role` claim is `usage_writer` and its `aud` is `dev-usage`.
PostgREST verifies signature, `aud` and `exp` against the realm's JWKS. No anonymous role is
configured: a request without a valid token is rejected (FR-014).

## Token acquisition (research R18)

```text
POST $MCM_USAGE_TOKEN_URL                       # realm token endpoint, over the tailnet
Content-Type: application/x-www-form-urlencoded
grant_type=client_credentials&client_id=dev-usage-capture&client_secret=$MCM_USAGE_CLIENT_SECRET
→ 200 { access_token, expires_in, … }
```

The secret travels only in the request body (never argv, never a URL). The token is cached in
`token.json` (0600) and reused until 60 s before expiry. Outcomes: `401/400` from the token endpoint →
`doctor` reports `client credential rejected`; `401` from the store with a fresh token → `doctor`
reports `store rejects token` (likely a signing-key rotation; redeploy the stack); network failure →
spool and back-off, as for the store.

## Writes (capture)

All writes are idempotent upserts: `POST /<table>` with
`Prefer: resolution=merge-duplicates,return=minimal` and `on_conflict=<natural key>`.

| Endpoint | `on_conflict` | Batch |
| --- | --- | --- |
| `POST /sessions` | `session_id` | 1 |
| `POST /model_calls` | `session_id,message_id` | ≤ 500 rows |
| `POST /turns` | `session_id,turn_seq` | ≤ 500 |
| `POST /tool_use` | `session_id,turn_seq,tool,command_family` | ≤ 500 |
| `POST /skill_use` | `session_id,skill` | ≤ 100 |
| `POST /features` | `feature_id` | ≤ 50 |
| `POST /token_weights` | `as_of` | 1 |
| `POST /findings` | `finding_id` | ≤ 100 |
| `PATCH /sessions?session_id=eq.<id>` | — | `manual_tag` only |
| `PATCH /findings?finding_id=eq.<id>` | — | `status`, `accepted_at` |

Order within one ship: `sessions` and `features` first (FK parents), then `turns`, `model_calls`,
`tool_use`, `skill_use`. Open-feature resolution reads `GET /features?branch=eq.<b>&pr_state=in.(none,open)`
before a turn on a branch not in the local cache is shipped. A failure mid-ship spools the **whole** batch; replay is safe because every write upserts.

## Reads (skill and dashboard)

`GET /v_session_totals`, `/v_turn_totals`, `/v_session_activity_mix`, `/v_baseline`,
`/v_feature_totals`, `/v_no_feature_totals`, `/v_feature_efficiency`, `/v_weekly_trend`, `/features`,
`/findings` with PostgREST filters
(`?branch=eq.…&started_at=gte.…&order=…&limit=…`).

## Forbidden by the role (asserted by an integration test)

- `DELETE` on any table → 401/403.
- Any request without a token, or with a token whose `role` is not `usage_writer` → rejected.
- Writing a column the data model does not define → 400 (no free-form columns).

## Record shape constraints (asserted by the privacy guard test on parser output)

- No string field longer than 200 characters except `findings.suggestion`.
- No field named or containing `content`, `text`, `prompt`, `stdout`, `stderr`, `command`, `path`,
  `filePath`, `description`, `oldString`, `newString`.
- Fixture transcripts plant sentinel strings in every content field; no sentinel may appear anywhere in
  the serialized batch.
