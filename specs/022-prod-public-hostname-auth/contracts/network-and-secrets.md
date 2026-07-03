# Contract: Network naming & secret handling

**Artifacts**: `scripts/check-resource-naming.mjs`, `contracts/naming-convention.md` (repo), `*.env.prod.example`.

## MUST hold (verifiable)

1. The ingress network is named `edge-network` (satisfies `^[a-z0-9-]+-network$`) and is listed in `APPROVED_NETWORKS` in `scripts/check-resource-naming.mjs`.
2. If `contracts/naming-convention.md` exists in the repo, `edge-network` is documented there.
3. Every committed prod compose references credentials only as fail-fast `${VAR:?…}` — never an inline literal, never a `${VAR:-literal}` / `?? 'literal'` default (FR-020).
4. Committed `*.env.prod.example` templates contain placeholders only — no real values (FR-021).
5. **Single-source DB password** (feature-022 follow-up): one `${KC_DB_PASSWORD}` is interpolated by BOTH the Postgres service (`POSTGRES_PASSWORD`) and keycloak-service (`KC_DB_PASSWORD`) — no `secrets/*.txt` file-secret, no `POSTGRES_PASSWORD_FILE`, no `.env.local` dual-source.
6. Real `*.env.prod` are gitignored.

## Verify

- `node scripts/check-resource-naming.mjs --section=all` passes (and fails before the allowlist edit — RED→GREEN).
- `node scripts/check-no-inline-secrets.mjs --selftest && node scripts/check-no-inline-secrets.mjs` pass (SC-005).
- `node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs` pass (SC-005).
- `git check-ignore infrastructure-as-code/docker/keycloak/.env.prod` returns the path (ignored).
- Unset a required var → `docker compose config` aborts naming it (SC-006).
