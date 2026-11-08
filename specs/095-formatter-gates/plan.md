# Plan 095: The constitution's formatters are enforced

**Spec**: [spec.md](./spec.md)

## Approach

1. **Rust**: run `cargo fmt` over mc-service once. Prefix the `lint` command with
   `cargo fmt --manifest-path backend/mc-service/Cargo.toml -p mc-service --check &&`. That prefix has no
   bare ` -- `, so the guard's `split(' -- ')` still finds `--all-targets` before the separator.
   `rustfmt` is already a component in `rust-toolchain.toml`.
2. **Python**: run `uv run ruff format .` in each of the four projects. Prefix each `lint` command with
   `uv run ruff format --check . &&`. Ruff's existing `[tool.ruff]` line length applies.
3. **TypeScript**: add `prettier` 3.9.10 (exact) as a root dev dependency, with `.prettierrc.json`
   (`singleQuote`, `trailingComma: all`, `printWidth: 100`, the closest match to the existing code) and
   `.prettierignore`. Run `prettier --write` over code files in both projects. Append a `prettier --check`
   to each project's `lint` command.
4. Update the rustfmt gotcha (canonical): the drift and the "format only what you touch" rule are gone.

Each reformat is its own commit, so `git blame --ignore-rev` can skip it. The commits are listed in
`.git-blame-ignore-revs`.

## Rollback

Revert the gate commit to stop enforcing. The formatting commits are behaviour-neutral and can stay.
