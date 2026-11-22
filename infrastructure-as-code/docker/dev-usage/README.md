# dev-usage — the Claude Code token usage store (feature 105)

Postgres (schema `usage`) behind PostgREST, fed by the dev container's Claude Code hooks
(`scripts/cc-usage.mjs`). Counts only, never content.

- `compose.prod.yaml`: the production Komodo stack `prod-dev-usage` (PostgREST on 19040,
  tailnet-only, Keycloak tokens only).
- `compose.yaml`: the integration twin, brought up only by
  `pnpm nx dev-usage-integration infrastructure-as-code`.
- `schema/`: idempotent SQL, re-applied in name order on every deploy and restart.
- `tests/`: the store contract tests.

Operator setup, checks, the `doctor` reference, key rotation, backup, the restore drill and format
drift: **[docs/runbooks/dev-usage.md](../../../docs/runbooks/dev-usage.md)**.
