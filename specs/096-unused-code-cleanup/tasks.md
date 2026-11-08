# Tasks 096: Unused code removed, and four backup suites fail by name

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [X] **T001** Remove the 15 unused symbols; add the guard call to the four backup suites.
- [X] **T002** Verify: `eslint .` reports 0 `no-unused-vars`; mcm-app lint and typecheck pass; the touched
  unit suites pass.

## Evidence

| Task | Result | Run |
|---|---|---|
| T002 | `no-unused-vars: 0` (was 15). `pnpm nx run-many -t lint,typecheck -p mcm-app`: 2 succeeded. Jest over `admin-settings-api.test.ts` and `src/components/agent`: 18 suites, 141 tests passed. The four integration suites need the backup targets and are not run here; typecheck covers them | Local |
