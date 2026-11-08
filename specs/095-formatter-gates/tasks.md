# Tasks 095: The constitution's formatters are enforced

**Input**: [spec.md](./spec.md), [plan.md](./plan.md)

- [X] **T001** Format mc-service; format the four Python projects; format mcm-app and design-system code.
  One commit per formatter, formatting only.
- [X] **T002** Add each check to its project's `lint` target.
  **Verify RED**: revert one formatted file per stack, and `pnpm nx lint <project>` fails.
  **Verify GREEN**: restore it, and lint passes.
- [X] **T003** Lint, typecheck and unit tests pass for every reformatted project, along with the
  mc-service lint guard (FR-004, FR-005).
- [X] **T004** Update the rustfmt gotcha and the constitution notes; list the commits in
  `.git-blame-ignore-revs`.
- [ ] **T005** Open the PR and get green CI. **Quote** the run numbers.

## Evidence

| Task | Result | Run |
|---|---|---|
| T001 | 4 formatting-only commits: rustfmt 6 files; ruff 83 files; Prettier 401 + 14 files (the 14 under `backups/` were skipped by the first root run, see `.prettierignore`). Listed in `.git-blame-ignore-revs` | Local |
| T002 RED | One file unformatted per stack: `pnpm nx lint` exit 1 for mc-service (fails in 261 ms, before clippy runs), movie-mcp and design-system | Local |
| T002 GREEN | Restored: all three exit 0. `scripts/__tests__/formatter-gates.guard.test.mjs`: 11 pass, and 1 fail with a check removed from movie-mcp's lint | Local |
| T003 | `run-many -t lint,typecheck` over all 7 projects: 8 succeeded. `run-many -t test` over the 6 non-Rust projects: 6 succeeded. `nx test:unit mc-service`: 1 succeeded. `mc-service-lint-all-targets.guard`: 8 pass. Scripts suite: 2015 pass | Local |
| T004 | Gotcha `rust-formatting-scope.md` rewritten; `okf-lint` and `okf-governance` exit 0 | Local |
