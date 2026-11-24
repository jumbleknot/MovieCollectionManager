#!/usr/bin/env bash
# Install rustup with NO toolchain, from a sha256-verified rustup-init — the ONE rustup bootstrap for
# every CI job that needs Rust (items #1114, #1119): app-ci's mc-service-checks, renovate.yml's
# Cargo.lock maintenance, and guardrails' sast (through scripts/ci-install-rust-audit.sh).
#
#   bash scripts/ci-install-rustup.sh
#
# It replaced `curl https://sh.rustup.rs | sh` — a fetched, unverified, MOVING script piped into sh.
# The binary is checked against the sha256 rustup PUBLISHES beside it:
#
#   static.rust-lang.org/rustup/archive/<V>/x86_64-unknown-linux-gnu/rustup-init.sha256
#
# `--default-toolchain none`: the Rust version is rust-toolchain.toml's (item #307). The first cargo
# call inside the repo installs exactly that channel and its components.
#
# The pin is a (version, sha256) PAIR, and the sha256 names the version it was taken for. Renovate
# moves RUSTUP_VERSION alone; the mismatch then fails here at run time AND offline in
# renovate-workflow.guard.test.mjs, naming where to read the new sha256 — never a silent re-trust.
#
# Linux x86_64 only: every CI job runs on the amd64 runner. The dev-container image is multi-arch and
# keeps its own bootstrap (docs/runbooks/renovate.md §7).
#
# Test seams (scripts/__tests__/ci-install-rust-audit.test.mjs, offline against file://):
#   MCM_RUSTUP_BASE_URL   default https://static.rust-lang.org/rustup/archive
#   MCM_RUST_RETRY_DELAY  seconds between curl retries, default 5
#   MCM_RUST_PLATFORM     platform as `uname -s`-`uname -m`, default from uname
set -euo pipefail

RUSTUP_VERSION=1.29.3
RUSTUP_INIT_SHA256_FOR=1.29.3
RUSTUP_INIT_SHA256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55

die() { echo "ci-install-rustup: $*" >&2; exit 1; }
[ "$#" -eq 0 ] || { echo "usage: $0   (no arguments; the pin lives in this file)" >&2; exit 2; }

[ "$RUSTUP_INIT_SHA256_FOR" = "$RUSTUP_VERSION" ] ||
  die "RUSTUP_VERSION is $RUSTUP_VERSION but RUSTUP_INIT_SHA256 was taken for $RUSTUP_INIT_SHA256_FOR — copy the new value from static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init.sha256"

PLATFORM=${MCM_RUST_PLATFORM:-$(uname -s)-$(uname -m)}
case "$PLATFORM" in
  Linux-x86_64) ;;
  *) die "pinned for Linux-x86_64 only, not $PLATFORM — add that platform's (asset, sha256) pair" ;;
esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

URL="${MCM_RUSTUP_BASE_URL:-https://static.rust-lang.org/rustup/archive}/$RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init"
rc=0
curl -fsSL --proto '=https,file' --retry 3 --retry-all-errors --retry-delay "${MCM_RUST_RETRY_DELAY:-5}" \
  --connect-timeout 20 -o "$WORK/rustup-init" "$URL" || rc=$?
[ "$rc" -eq 0 ] || die "download failed (curl exit $rc, after retries): $URL"
echo "ci-install-rustup: downloaded rustup-init ($(wc -c <"$WORK/rustup-init") bytes)"

printf '%s  %s\n' "$RUSTUP_INIT_SHA256" "$WORK/rustup-init" | sha256sum -c --status - ||
  die "checksum mismatch for rustup-init (expected $RUSTUP_INIT_SHA256, got $(sha256sum "$WORK/rustup-init" | cut -d' ' -f1))"
echo "ci-install-rustup: sha256 verified for rustup-init"

chmod +x "$WORK/rustup-init"
"$WORK/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none
echo "ci-install-rustup: rustup $RUSTUP_VERSION in ${CARGO_HOME:-$HOME/.cargo}/bin (toolchain from rust-toolchain.toml)"
