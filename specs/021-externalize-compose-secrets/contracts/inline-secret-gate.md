# Contract: Inline-Secret Gate (`scripts/check-no-inline-secrets.mjs`)

A static gate, structured like `scripts/check-resource-naming.mjs`, asserting that no tracked Docker Compose file holds a literal credential. Complementary to `scripts/secret-scan.mjs` (which hunts real-key *shapes* tree-wide); this asserts a *structural* property of compose files.

## Invocation

`node scripts/check-no-inline-secrets.mjs [--selftest]`

- default: scan tracked compose files; exit `0` if clean, `1` with offending `file:key (sample)` lines if not.
- `--selftest`: prove the detector flags a planted literal and passes a clean `${VAR}` sample (mirrors `secret-scan.mjs --selftest`); exit non-zero if detection is broken.

## Scope

Tracked files matched by both:
- `infrastructure-as-code/docker/**/compose*.yaml` (component files), and
- `infrastructure-as-code/docker/stacks/*.compose.yaml` (stacks), and
- the root `compose.yaml` (retired pointer — should stay clean).

Parsed with the `yaml` root dependency.

## Detection rule (FR-008)

For every service, a value **fails** when a secret-shaped key holds a literal instead of a pure interpolation reference:

- **Secret-shaped keys** (case-insensitive, in `environment` maps and lists): name matches `PASSWORD | SECRET | TOKEN | _AUTH$ | ROOT_TOKEN | SECRET_ACCESS_KEY | REQUIREPASS`.
- **Password-bearing URLs** (any value): matches `://[^:/@\s]+:[^@\s]+@` where the password segment is not a `${…}` reference.
- **Embedded in `command` / `healthcheck.test` / `entrypoint`**: the same URL rule, plus `--requirepass <literal>`, `-a <literal>`, `-u user:<literal>` patterns.

**Pass** = the value is exactly `${VAR}` or `${VAR:?…}` (a `${VAR:-default}` form **fails** — an inline default re-leaks plaintext, spec AC2).

**Allowlist** (non-secret keys/values that match a secret-shaped pattern but are not credentials) — explicitly enumerated, mirroring `check-resource-naming.mjs`'s `NAME_ALLOWLIST`:
- keys: `*_USER`, `*ACCESS_KEY_ID`, `MINIO_ROOT_USER`.
- the deterministic fixtures `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `LANGFUSE_INIT_PROJECT_SECRET_KEY` — but only the value present in `.env.example`; in compose they MUST still be `${…}`.

## TDD checkpoints (maps to spec FR-008 / SC-005)

- **Verify RED** (before externalization): `node scripts/check-no-inline-secrets.mjs` exits `1`, listing the ~25 current literals across the 6 component files.
- **Verify GREEN** (after externalization): same command exits `0`.
- **Selftest**: `node scripts/check-no-inline-secrets.mjs --selftest` exits `0` (detects a planted `POSTGRES_PASSWORD: hunter2` and a `${VAR}` clean sample passes).
- **CI**: a regression PR that re-inlines any literal turns the `naming-gate.yml` job red.

## Exit codes

- `0` — clean / selftest passed.
- `1` — at least one inline credential found / selftest failed to detect.
- `2` — bad arguments or unparseable file.
