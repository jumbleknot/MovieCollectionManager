# Tasks 091: Align the malformed-token test with axum-keycloak-auth 0.8.4

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [X] **T001** Record the failure on `main`. **Verify RED**: `left: 401`, `right: 400`.
- [X] **T002** Update the test and its comment (FR-001, FR-002).
- [ ] **T003** Open the PR and get green CI. **Verify GREEN** (SC-001): **Quote** the run number.

## Evidence

| Task | Result | Run |
|---|---|---|
| T001 RED | `movie_metadata_rejects_a_malformed_token ... FAILED`, `left: 401`, `right: 400`; `131 passed; 1 failed`. Same result on `main` at `2d9ed170`, on #947 and on #952 | 6947, 6952, 6955 |
| T003 GREEN | | |
