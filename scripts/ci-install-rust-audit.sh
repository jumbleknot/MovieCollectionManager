#!/usr/bin/env bash
# Install rustup (NO toolchain) and a PREBUILT, checksum-pinned cargo-audit — the sast job's Rust
# tooling (item #1114).
#
#   bash scripts/ci-install-rust-audit.sh
#
# It replaced two things. `curl https://sh.rustup.rs | sh` ran a fetched, unverified script; and
# `cargo install cargo-audit --locked --version X` COMPILED cargo-audit from source on every run
# (minutes, plus an apt step for build-essential/pkg-config/libssl-dev that existed only for it).
#
# rustup comes from scripts/ci-install-rustup.sh — the one rustup pin every CI job shares (item
# #1119). cargo-audit is downloaded here and verified against the sha256 its publisher states: the
# release asset's `digest` on github.com/rustsec/rustsec (GitHub's own sha256). rustup stays because
# the scan's first `cargo tree` installs rust-toolchain.toml's toolchain.
#
# A pin is a (version, sha256) PAIR, and the sha256 names the version it was taken for. Renovate
# moves the version alone; the mismatch then fails here at run time AND offline in
# renovate-workflow.guard.test.mjs, naming where to read the new sha256 — never a silent re-trust.
#
# Test seams (scripts/__tests__/ci-install-rust-audit.test.mjs, offline against file://) — those of
# ci-install-rustup.sh, plus:
#   MCM_CARGO_AUDIT_BASE_URL  default https://github.com/rustsec/rustsec/releases/download
set -euo pipefail

CARGO_AUDIT_VERSION=0.23.0
CARGO_AUDIT_SHA256_FOR=0.23.0
CARGO_AUDIT_SHA256=4f01c74ed84b2dffd0b1d37012a62cdf2a92c96e25bdf8eec7fcc0d4d3eb7811

die() { echo "ci-install-rust-audit: $*" >&2; exit 1; }
[ "$#" -eq 0 ] || { echo "usage: $0   (no arguments; the pins live in this file)" >&2; exit 2; }

[ "$CARGO_AUDIT_SHA256_FOR" = "$CARGO_AUDIT_VERSION" ] ||
  die "CARGO_AUDIT_VERSION is $CARGO_AUDIT_VERSION but CARGO_AUDIT_SHA256 was taken for $CARGO_AUDIT_SHA256_FOR — copy the musl asset's digest from the cargo-audit/v$CARGO_AUDIT_VERSION release on github.com/rustsec/rustsec"

PLATFORM=${MCM_RUST_PLATFORM:-$(uname -s)-$(uname -m)}
case "$PLATFORM" in
  Linux-x86_64) ;;
  *) die "pinned for Linux-x86_64 only, not $PLATFORM — add that platform's (asset, sha256) pair" ;;
esac

# ── rustup, no toolchain (the shared bootstrap) ───────────────────────────────────────────────────
bash "$(dirname "${BASH_SOURCE[0]}")/ci-install-rustup.sh"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
CARGO_BIN="${CARGO_HOME:-$HOME/.cargo}/bin"

# ── cargo-audit, prebuilt ─────────────────────────────────────────────────────────────────────────
ASSET="cargo-audit-x86_64-unknown-linux-musl-v$CARGO_AUDIT_VERSION"
URL="${MCM_CARGO_AUDIT_BASE_URL:-https://github.com/rustsec/rustsec/releases/download}/cargo-audit%2Fv$CARGO_AUDIT_VERSION/$ASSET.tgz"
rc=0
curl -fsSL --proto '=https,file' --retry 3 --retry-all-errors --retry-delay "${MCM_RUST_RETRY_DELAY:-5}" \
  --connect-timeout 20 -o "$WORK/$ASSET.tgz" "$URL" || rc=$?
[ "$rc" -eq 0 ] || die "download failed (curl exit $rc, after retries): $URL"
echo "ci-install-rust-audit: downloaded $ASSET.tgz ($(wc -c <"$WORK/$ASSET.tgz") bytes)"

printf '%s  %s\n' "$CARGO_AUDIT_SHA256" "$WORK/$ASSET.tgz" | sha256sum -c --status - ||
  die "checksum mismatch for $ASSET.tgz (expected $CARGO_AUDIT_SHA256, got $(sha256sum "$WORK/$ASSET.tgz" | cut -d' ' -f1))"
echo "ci-install-rust-audit: sha256 verified for $ASSET.tgz"

tar -xzf "$WORK/$ASSET.tgz" -C "$WORK" "$ASSET/cargo-audit" || die "$ASSET.tgz has no $ASSET/cargo-audit"
mkdir -p "$CARGO_BIN"
install -m 0755 "$WORK/$ASSET/cargo-audit" "$CARGO_BIN/cargo-audit"

# "The step passed" must mean "this version is on PATH", not "a version line was printed".
GOT=$("$CARGO_BIN/cargo-audit" audit --version 2>&1 || true)
case " $GOT " in
  *" $CARGO_AUDIT_VERSION "*) ;;
  *) die "installed $CARGO_BIN/cargo-audit reports '${GOT:-<nothing>}', expected $CARGO_AUDIT_VERSION" ;;
esac
echo "ci-install-rust-audit: cargo-audit $CARGO_AUDIT_VERSION in $CARGO_BIN"
