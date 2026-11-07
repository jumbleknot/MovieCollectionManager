# Tasks 090: Keycloak Admin API scope

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [X] **T001** Add `scripts/__tests__/keycloak-admin-api-scope.guard.test.mjs` for FR-001, FR-002, FR-004.
  **Verify RED**: fails because no realm file has the scope and the script does not exist.
- [X] **T002** Add `infrastructure-as-code/docker/keycloak/scripts/ensure-admin-api-scope.mjs`, and the
  scope and assignment in all three realm files. **Verify GREEN**: the same test passes.
- [X] **T003** Prove SC-001 and SC-002 against real Keycloak images, using the script itself.
- [X] **T004** Document it in the Keycloak README and `docs/runbooks/renovate.md` (FR-005).
- [ ] **T005** Open the PR and get green CI. **Quote** the run numbers.
- [ ] **T006** Operator: run the script on production, dry run first, then `--apply`.
- [ ] **T007** Rebase PR #950 on this change, get it green (SC-003), and merge it after T006.

## Evidence

| Task | Result | Run |
|---|---|---|
| T001 RED | `fail 7`, `pass 0`: `the scope must be DEFINED here` on each realm file, `Cannot find module` for the script | Local |
| T002 GREEN | `pass 10`, `fail 0`, with `keycloak-realm-schema.test.mjs` | Local |
| T003, SC-001 | Fresh import of `ci`, `dev` and `prod` (with `BASE_DOMAIN` rendered, as production does) on 26.8.1 and 26.8.2: scope assigned, one `kc-admin-api`. `ci` service account Admin API call: 200 on both. The unchanged prod file, unrendered, also fails to start, so that failure is not this change | Local |
| T003, SC-002 | 26.8.1 realm: dry run `to do: create-scope, assign-scope`, nothing changed. `--apply`: `done`. Again: `nothing, already in place`. 200 before the upgrade, 200 after it, one scope | Local |
| T003, repair | Realm upgraded with no script: 401. `--apply`, `to do: assign-scope`: 200 | Local |
| T005 | | |
| T006 | | |
| T007 | | |
