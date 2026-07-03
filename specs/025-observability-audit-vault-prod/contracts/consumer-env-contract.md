# Contract: Consumer Env Vars (app stacks → new capabilities)

**Consumers**: `prod-mcm-bff` (BFF) and `prod-movie-assistant` (gateway).
**Governing invariant**: every variable below is **optional**. Unset (or empty) ⇒ the corresponding integration is a silent no-op ⇒ the app's prior behavior is byte-for-byte unchanged (FR-009, SC-008). This is verified in source: the gate expressions are listed per row.

## Variables

| Capability | Env var | Prod value (internal DNS) | Gate (source) | On unset |
|---|---|---|---|---|
| Append-only audit | `OPENSEARCH_URL` | `https://agent-audit-opensearch:9200` | `audit_sink.py` `e.get("OPENSEARCH_URL")` | log-only audit (no POST) |
| Append-only audit | `OPENSEARCH_USERNAME` | `agent-audit` | with `OPENSEARCH_URL` | — |
| Append-only audit | `OPENSEARCH_PASSWORD` | `[[OPENSEARCH_AUDIT_WRITER_PASSWORD]]` | with `OPENSEARCH_URL` | — |
| LLM observability | `LANGFUSE_HOST` | `http://langfuse-web:3000` | `observability.py` default `:3030` if unset | — |
| LLM observability | `LANGFUSE_PUBLIC_KEY` | `[[LANGFUSE_INIT_PROJECT_PUBLIC_KEY]]` | `is_langfuse_enabled` = both keys set | no trace handler |
| LLM observability | `LANGFUSE_SECRET_KEY` | `[[LANGFUSE_INIT_PROJECT_SECRET_KEY]]` | `is_langfuse_enabled` | no trace handler |
| Infra telemetry | `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-lgtm:4318` | `observability.py` `OTEL_EXPORTER_OTLP_ENDPOINT` | no OTel export |
| Policy | `OPA_URL` | `http://opa-service:8181` | `tools/opa.py` `is_opa_configured` | check skipped (allow) |
| Feature flags | `UNLEASH_URL` | `http://unleash-service:4242/api` | `flags.py`/`kill_switch.py` `UNLEASH_URL` | env-flag / default-off |
| Feature flags | `UNLEASH_API_TOKEN` | `[[UNLEASH_CLIENT_TOKEN]]` (client token, NOT admin) | with `UNLEASH_URL` | — |

## Wiring mechanics

- Each var is declared in the stack's `stacks.toml` `environment` block as `NAME=[[KOMODO_VAR]]` (Komodo writes it into `.env.prod`), and referenced in `compose.prod.yaml` as `${NAME}` (or `${NAME:?}` only where the value is a hard requirement — here they stay **optional**, so plain `${NAME}` / `${NAME:-}` to preserve no-op semantics).
- **Do NOT** make these `${VAR:?}` fail-fast on the app stacks — that would break the additive contract (a missing observability var must not abort the app).
- Fixed (non-secret) values (`OPENSEARCH_URL`, `OPENSEARCH_USERNAME`, `LANGFUSE_HOST`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OPA_URL`, `UNLEASH_URL`) are literals in `compose.prod.yaml` `environment:` — internal container DNS, no host/domain, topology-scrub clean.

## Phasing (FR-010)

1. Deploy `prod-audit` + `prod-observability` (support stacks) — the app is NOT yet wired ⇒ behavior unchanged.
2. Add the vars above + seed the Komodo Variables ⇒ re-sync ⇒ the gateway/BFF begin emitting/enforcing.
3. Reverting = removing the vars ⇒ back to no-op (reversible).
