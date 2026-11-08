# Spec 095: The constitution's formatters are enforced, as it says they are

**Status**: Complete | **Date**: 2026-11-08 | **Input**: implementation review, 2026-11-08 (best-practice
step). The operator chose to adopt all three formatters in one change ("Do both now").

## Problem

`.specify/memory/constitution.md` names one formatter per stack, each "enforced in CI/CD": `cargo fmt`
(Rust), Prettier (TypeScript) and `ruff format` (Python). None of them was enforced:

- **Rust**: `cargo fmt --check` drifted in 6 mc-service files. The `lint` target runs clippy only.
- **Python**: 83 files across movie-assistant and the three MCP servers were not `ruff format`-clean. The
  `lint` targets run `ruff check` and `mypy` only.
- **TypeScript**: Prettier was not a dependency, had no configuration, and was never run. 401 TS/TSX/JS
  files in mcm-app and design-system differ from its output.

The drift had become a convention. The rustfmt gotcha told contributors to "format only what you touch",
because a whole-crate format produced an unrelated diff. A rule that reads as enforced but is not costs
every change a review of noise.

## Requirements

- **FR-001**: Each formatter MUST be checked by the project's existing `lint` target, so it runs wherever
  lint runs (`nx affected` in `app-ci`, and `mc-service-checks` for Rust) with no new CI job.
- **FR-002**: The tree MUST be formatted once, in commits that contain formatting only.
- **FR-003**: Prettier MUST be pinned to an exact version, so a formatter release cannot fail CI on code
  nobody touched. Its scope is code (`.ts`, `.tsx`, `.js`, `.mjs`) in mcm-app and design-system.
- **FR-004**: The reformatting MUST NOT change behaviour. Lint, typecheck and the unit suites of every
  reformatted project MUST pass.
- **FR-005**: The guard pinning mc-service's `lint` command (`--all-targets`, `-D warnings`) MUST still pass.

## Success criteria

- **SC-001**: `cargo fmt --check`, `ruff format --check` and `prettier --check` are clean on the branch.
- **SC-002**: Unformatted code fails `pnpm nx lint <project>` (checked by reverting one file).
- **SC-003**: Every affected project's lint, typecheck and unit tests pass.

## Out of scope

- Formatting YAML, Markdown or JSON with Prettier.
- Formatting `scripts/` and `tools/`, which have no lint target.
