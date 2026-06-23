# Contract: Network naming & secret handling

**Artifacts**: `scripts/check-resource-naming.mjs`, `contracts/naming-convention.md` (repo), `*.env.prod.example`, `secrets/keycloak_db_password.txt`.

## MUST hold (verifiable)

1. The ingress network is named `edge-network` (satisfies `^[a-z0-9-]+-network$`) and is listed in `APPROVED_NETWORKS` in `scripts/check-resource-naming.mjs`.
2. If `contracts/naming-convention.md` exists in the repo, `edge-network` is documented there.
3. Every committed prod compose references credentials only as fail-fast `${VAR:?…}` — never an inline literal, never a `${VAR:-literal}` / `?? 'literal'` default (FR-020).
4. Committed `*.env.prod.example` templates contain placeholders only — no real values (FR-021).
5. The Keycloak DB password uses the file-secret pattern; the file content equals the `KC_DB_PASSWORD` value the BFF uses (cross-entity invariant).
6. Real `*.env.prod` and `secrets/*.txt` are gitignored.

## Verify

- `node scripts/check-resource-naming.mjs --section=all` passes (and fails before the allowlist edit — RED→GREEN).
- `node scripts/check-no-inline-secrets.mjs --selftest && node scripts/check-no-inline-secrets.mjs` pass (SC-005).
- `node scripts/secret-scan.mjs --selftest && node scripts/secret-scan.mjs` pass (SC-005).
- `git check-ignore infrastructure-as-code/docker/keycloak/.env.prod` returns the path (ignored).
- Unset a required var → `docker compose config` aborts naming it (SC-006).
