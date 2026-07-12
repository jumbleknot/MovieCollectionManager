#!/usr/bin/env bash
# verify-toolchain-present.sh — feature 038 (full dev-container toolchain)
#
# Governing success criteria: SC-001 (every team tool on PATH at container start, each reports a
# version) and SC-002 (all three language layers + the SDD CLI run in-container, no host fallback).
# Governing requirements:     FR-001 (full toolchain present), FR-002 (non-root).
#
# Asserts, from INSIDE the dev container, that every tool the team workflow needs resolves on PATH
# and prints a version — Rust + the cargo-utility set the repo's quality/security gates invoke
# (033/034/035 + tarpaulin coverage), the Python/uv + Specify SDD toolchain, Node/pnpm/Nx, and gh.
#
# RED-first: run against the 037 baseline image (Node+pnpm only) this FAILS immediately — rustc,
# uv, gh, specify, and the cargo utilities are all "command not found". GREEN after the US1
# toolchain layers land in toolchain.Dockerfile.
# Exit 0 = full toolchain present; non-zero = a required tool is missing.

set -uo pipefail

fail=0
err() { printf '  ✗ %s\n' "$1" >&2; fail=1; }
ok()  { printf '  ✓ %s\n' "$1"; }

echo "[verify-toolchain-present] SC-001 / SC-002"

# Non-fabrication guard: the proof is only meaningful inside the container.
if [ "${MCM_DEVCONTAINER:-}" != "1" ]; then
  echo "  ✗ MCM_DEVCONTAINER != 1 — not running inside the dev container (RED / run in-container)" >&2
  echo "[verify-toolchain-present] FAIL (not in container)"; exit 1
fi

# check_tool <command> [version-args...]
# Asserts the command resolves on PATH AND exits 0 for a version probe (proves it actually runs,
# not just a dangling name). Default probe is `--version`.
check_tool() {
  local cmd="$1"; shift
  local -a vargs=("$@")
  [ "${#vargs[@]}" -eq 0 ] && vargs=(--version)
  if ! command -v "$cmd" >/dev/null 2>&1; then
    err "$cmd — not found on PATH"
    return
  fi
  if "$cmd" "${vargs[@]}" >/dev/null 2>&1; then
    ok "$cmd present ($(command -v "$cmd"))"
  else
    err "$cmd on PATH but '$cmd ${vargs[*]}' failed — not runnable"
  fi
}

echo "  — Rust core"
check_tool rustc
check_tool cargo
check_tool rustfmt
check_tool rust-analyzer --version
# clippy is invoked as `cargo clippy`; the driver binary is clippy-driver.
check_tool clippy-driver --version
if cargo clippy --version >/dev/null 2>&1; then ok "cargo clippy runs"; else err "cargo clippy — not runnable"; fi

echo "  — cargo utilities (repo quality/security gates: 033/034/035 + coverage)"
for t in cargo-audit cargo-deny cargo-outdated cargo-machete cargo-semver-checks \
         cargo-geiger cargo-expand cargo-bloat cargo-mutants cargo-tarpaulin; do
  check_tool "$t" --version
done

echo "  — Python / SDD toolchain"
check_tool uv
check_tool uvx --version
check_tool specify --help

echo "  — Node / JS toolchain"
check_tool node
check_tool pnpm
check_tool gh --version
# Nx is driven via `pnpm nx` (no global). Prove it resolves in the workspace.
if command -v pnpm >/dev/null 2>&1 && pnpm nx --version >/dev/null 2>&1; then
  ok "pnpm nx resolves ($(pnpm nx --version 2>/dev/null | head -1))"
else
  err "pnpm nx — not resolvable (run from the workspace root)"
fi

if [ "$fail" -eq 0 ]; then
  echo "[verify-toolchain-present] PASS (SC-001 / SC-002)"; exit 0
else
  echo "[verify-toolchain-present] FAIL — a required tool is missing (SC-001 / SC-002)"; exit 1
fi
