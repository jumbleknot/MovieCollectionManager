# Quickstart: Validating Dev-Container Stack Reproducibility

Runnable validation scenarios that prove the feature end-to-end. Prereqs: repo cloned, Docker running, `pnpm install` done. Shell examples are PowerShell-friendly; the `docker`/`node` commands are cross-shell.

## Scenario 1 — Fresh-volume realm seed → working login (US1 / AC1, SC-001, SC-007)

Proves the dev realm is imported automatically on a clean volume and login works.

```bash
# 1. Simulate a from-scratch box: wipe the auth realm store
docker compose -p auth -f infrastructure-as-code/docker/stacks/auth.compose.yaml down -v
docker volume rm keycloak-store-postgres-data        # (recreate if declared external)
docker volume create keycloak-store-postgres-data

# 2. Mint per-machine secrets (now includes the realm's client secrets + E2E_TEST_PASSWORD)
node scripts/gen-dev-secrets.mjs

# 3. Standard dev auth bring-up (dev overlay adds --import-realm + dev-realm.json)
pnpm nx up-auth infrastructure-as-code   # waits for keycloak-service healthy

# 4. Assert the realm + user + clients seeded and login works (regression guard)
node verify/verify-fresh-realm-seed.mjs
```

**Expected**: Keycloak comes up with the `grumpyrobot` realm, `e2e-test-user`, and all app clients present; `verify-fresh-realm-seed.mjs` reports a successful headless PKCE login. **No** manual import, **no** CI overlay, **no** hand-editing (SC-001).

**Stale-password recovery (SC-007)**: repeating steps 1→3 (the documented volume wipe) leaves a working login — the realm re-seeds automatically.

**Established-volume non-regression (FR-002)**: run `pnpm nx up-auth` twice on a volume that already has the realm → no duplicate-import error, realm unchanged.

## Scenario 2 — Clean dev-container open → green web E2E (US1+US3 / AC2, SC-002)

```bash
# From a freshly (re)built dev container, committed config + gen-dev-secrets only:
node scripts/gen-dev-secrets.mjs
pnpm nx up-auth infrastructure-as-code
pnpm nx docker-build mcm-app
docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml --profile app --profile bff-nonsecure up -d --wait
E2E_BFF_TARGET=dev-container pnpm nx e2e mcm-app
```

**Expected**: the core web E2E is green with no bespoke realm-import step (SC-002).

## Scenario 3 — Dual-Compose parse & profile invariance (US3 / AC3, SC-003)

```bash
# Baseline BEFORE the change (on main), capture per-profile selection:
for P in "" "--profile app" "--profile bff-nonsecure" "--profile bff-secure" "--profile agents" "--profile agents-metro"; do
  docker compose -p mcm -f infrastructure-as-code/docker/stacks/mcm.compose.yaml $P config --services | sort
done

# AFTER the change, repeat under BOTH an older v2.40.x plugin and current v5.x — outputs must match the baseline.
docker compose version   # confirm the plugin under test
```

**Expected**: `config` exits 0 under both versions (no `conflicts with imported resource`); every profile's sorted service list is identical to the baseline (contracts/profile-selection-invariance.md).

## Scenario 4 — Realm consistency + no-literal-secret gate (US1 / AC4)

```bash
node scripts/check-realm-consistency.mjs --selftest   # proves the check can fail
node scripts/check-realm-consistency.mjs              # dev-realm ⟷ ci-realm client/user set match
node scripts/secret-scan.mjs                          # green with dev-realm.json committed
node scripts/check-no-inline-secrets.mjs
git check-ignore infrastructure-as-code/docker/keycloak/dev-realm.json   # expect: NOT ignored (exit 1)
```

**Expected**: consistency check passes (and `--selftest` proves it fails on a mutated fixture); secret gates green; `dev-realm.json` is tracked (SC-004).

## Scenario 5 — CI required-context always posted (US2 / AC6, SC-005)

Verified on the forge (one PR of each kind):

- **Docs-only PR**: head-SHA commit status shows `infra-image-scan / infra-image-scan = success`; the PR merges via the API with **no admin override**.
- **Infra-ref PR** (bump a pinned `image:` tag): the `infra-image-scan` job runs Trivy and **blocks** if a fixable-Critical is found.

(contracts/ci-required-context.md)

## Reset to normal dev

```bash
pnpm nx up-mcm infrastructure-as-code   # resume the normal dev loop
```
