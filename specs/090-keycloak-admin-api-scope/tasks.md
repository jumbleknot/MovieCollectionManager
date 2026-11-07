# Tasks 090: Keycloak Admin API scope

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [X] **T001** Add `scripts/__tests__/keycloak-admin-api-scope.guard.test.mjs` for FR-001, FR-002, FR-004.
  **Verify RED**: fails because no realm file has the scope and the script does not exist.
- [X] **T002** Add `infrastructure-as-code/docker/keycloak/scripts/ensure-admin-api-scope.mjs`, and the
  scope and assignment in all three realm files. **Verify GREEN**: the same test passes.
- [X] **T003** Prove SC-001 and SC-002 against real Keycloak images, using the script itself.
- [X] **T004** Document it in the Keycloak README and `docs/runbooks/renovate.md` (FR-005).
- [X] **T005** Open the PR and get green CI. **Quote** the run numbers.
- [X] **T006** Operator: straight after #950 upgrades production, assign `kc-admin-api` to `mcm-bff-service`
  in the console. The script cannot do this: production's admin uses two-factor. The operator chose this on
  2026-11-07, accepting that BFF admin calls answer 401 until the assignment is done. **Verify**: the BFF's
  client lookup answers 200 on 26.8.2.
- [X] **T007** Rebase PR #950 on this change and get it green (SC-003). Merge it only when the operator is
  ready at the console, because merging starts the upgrade.

## Evidence

| Task | Result | Run |
|---|---|---|
| T001 RED | `fail 7`, `pass 0`: `the scope must be DEFINED here` on each realm file, `Cannot find module` for the script | Local |
| T002 GREEN | `pass 10`, `fail 0`, with `keycloak-realm-schema.test.mjs` | Local |
| T003, SC-001 | Fresh import of `ci`, `dev` and `prod` (with `BASE_DOMAIN` rendered, as production does) on 26.8.1 and 26.8.2: scope assigned, one `kc-admin-api`. `ci` service account Admin API call: 200 on both. The unchanged prod file, unrendered, also fails to start, so that failure is not this change | Local |
| T003, SC-002 | 26.8.1 realm: dry run `to do: create-scope, assign-scope`, nothing changed. `--apply`: `done`. Again: `nothing, already in place`. 200 before the upgrade, 200 after it, one scope | Local |
| T003, repair | Realm upgraded with no script: 401. `--apply`, `to do: assign-scope`: 200 | Local |
| T005 | All 12 required contexts green at `f5d5bbd6`, after `main` took #953. Merged as `d01a2715` | app-ci 6984, guardrails 6985, infra-image-scan 6986 |
| T006 | Production, 2026-11-07, after #950 deployed. The operator confirmed 26.8.2 in the console and assigned `kc-admin-api` to `mcm-bff-service` as a default scope. Read-only check from the BFF container: Keycloak reachable 200, service-account token 200 carrying `kc-admin-api`, client lookup 200, user count 200 | Production, `fe91db2f` |
| T007 | Rebased by Renovate onto `main` with this change. All 12 required contexts green at `5337b429` on Keycloak 26.8.2, browser tests included. Merged as `fe91db2f` at the operator's word, 2026-11-07 14:45 UTC | app-ci 7012, guardrails 7013, infra-image-scan 7014 |
