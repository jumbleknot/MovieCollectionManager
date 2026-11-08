# Tasks 095: The constitution's formatters are enforced

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [ ] **T001** Format mc-service; format the four Python projects; format mcm-app and design-system code.
  One commit per formatter, formatting only.
- [ ] **T002** Add each check to its project's `lint` target.
  **Verify RED**: revert one formatted file per stack, and `pnpm nx lint <project>` fails.
  **Verify GREEN**: restore it, and lint passes.
- [ ] **T003** Lint, typecheck and unit tests pass for every reformatted project, along with the
  mc-service lint guard (FR-004, FR-005).
- [ ] **T004** Update the rustfmt gotcha and the constitution notes; list the commits in
  `.git-blame-ignore-revs`.
- [ ] **T005** Open the PR and get green CI. **Quote** the run numbers.

## Evidence

| Task | Result | Run |
|---|---|---|
