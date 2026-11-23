#!/usr/bin/env bash
# Install rustup (NO toolchain) and a PREBUILT, checksum-pinned cargo-audit — the sast job's Rust
# tooling (item #1114).
#
#   bash scripts/ci-install-rust-audit.sh
#
# It replaced two things. `curl https://sh.rustup.rs | sh` ran a fetched, unverified script; and
# `cargo install cargo-audit --locked --version X` COMPILED cargo-audit from source on every run
# (minutes, plus an apt step for build-essential/pkg-config/libssl-dev that existed only for it).
# Both artefacts are now downloaded directly and verified against the sha256 their publisher states:
#
#   rustup-init  static.rust-lang.org/rustup/archive/<V>/<target>/rustup-init.sha256
#   cargo-audit  the release asset's `digest` on github.com/rustsec/rustsec (GitHub's own sha256)
#
# `--default-toolchain none` is kept: the Rust version is rust-toolchain.toml's (item #307), and the
# scan's first `cargo tree` inside the repo installs exactly that. rustup stays because of that call.
#
# A pin is a (version, sha256) PAIR, and each sha256 names the version it was taken for. Renovate
# moves the version alone; the mismatch then fails here at run time AND offline in
# renovate-workflow.guard.test.mjs, naming where to read the new sha256 — never a silent re-trust.
#
# Test seams (scripts/__tests__/ci-install-rust-audit.test.mjs, offline against file://):
#   MCM_RUSTUP_BASE_URL       default https://static.rust-lang.org/rustup/archive
#   MCM_CARGO_AUDIT_BASE_URL  default https://github.com/rustsec/rustsec/releases/download
#   MCM_RUST_RETRY_DELAY      seconds between curl retries, default 5
#   MCM_RUST_PLATFORM         platform as `uname -s`-`uname -m`, default from uname
set -euo pipefail

RUSTUP_VERSION=1.29.3
RUSTUP_INIT_SHA256_FOR=1.29.3
RUSTUP_INIT_SHA256=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55

CARGO_AUDIT_VERSION=0.23.0
CARGO_AUDIT_SHA256_FOR=0.23.0
CARGO_AUDIT_SHA256=4f01c74ed84b2dffd0b1d37012a62cdf2a92c96e25bdf8eec7fcc0d4d3eb7811

die() { echo "ci-install-rust-audit: $*" >&2; exit 1; }
[ "$#" -eq 0 ] || { echo "usage: $0   (no arguments; the pins live in this file)" >&2; exit 2; }

[ "$RUSTUP_INIT_SHA256_FOR" = "$RUSTUP_VERSION" ] ||
  die "RUSTUP_VERSION is $RUSTUP_VERSION but RUSTUP_INIT_SHA256 was taken for $RUSTUP_INIT_SHA256_FOR — copy the new value from static.rust-lang.org/rustup/archive/$RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init.sha256"
[ "$CARGO_AUDIT_SHA256_FOR" = "$CARGO_AUDIT_VERSION" ] ||
  die "CARGO_AUDIT_VERSION is $CARGO_AUDIT_VERSION but CARGO_AUDIT_SHA256 was taken for $CARGO_AUDIT_SHA256_FOR — copy the musl asset's digest from the cargo-audit/v$CARGO_AUDIT_VERSION release on github.com/rustsec/rustsec"

PLATFORM=${MCM_RUST_PLATFORM:-$(uname -s)-$(uname -m)}
case "$PLATFORM" in
  Linux-x86_64) ;;
  *) die "pinned for Linux-x86_64 only, not $PLATFORM — add that platform's (asset, sha256) pair" ;;
esac

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fetch() {
  local url=$1 out=$2 rc=0
  curl -fsSL --proto '=https,file' --retry 3 --retry-all-errors --retry-delay "${MCM_RUST_RETRY_DELAY:-5}" \
    --connect-timeout 20 -o "$out" "$url" || rc=$?
  [ "$rc" -eq 0 ] || die "download failed (curl exit $rc, after retries): $url"
  echo "ci-install-rust-audit: downloaded $(basename "$out") ($(wc -c <"$out") bytes)"
}

verify() {
  local file=$1 want=$2
  printf '%s  %s\n' "$want" "$file" | sha256sum -c --status - || die "checksum mismatch for $(basename "$file") (expected $want, got $(sha256sum "$file" | cut -d' ' -f1))"
  echo "ci-install-rust-audit: sha256 verified for $(basename "$file")"
}

# ── rustup, no toolchain ──────────────────────────────────────────────────────────────────────────
fetch "${MCM_RUSTUP_BASE_URL:-https://static.rust-lang.org/rustup/archive}/$RUSTUP_VERSION/x86_64-unknown-linux-gnu/rustup-init" "$WORK/rustup-init"
verify "$WORK/rustup-init" "$RUSTUP_INIT_SHA256"
chmod +x "$WORK/rustup-init"
"$WORK/rustup-init" -y --no-modify-path --profile minimal --default-toolchain none

CARGO_BIN="${CARGO_HOME:-$HOME/.cargo}/bin"

# ── cargo-audit, prebuilt ─────────────────────────────────────────────────────────────────────────
ASSET="cargo-audit-x86_64-unknown-linux-musl-v$CARGO_AUDIT_VERSION"
fetch "${MCM_CARGO_AUDIT_BASE_URL:-https://github.com/rustsec/rustsec/releases/download}/cargo-audit%2Fv$CARGO_AUDIT_VERSION/$ASSET.tgz" "$WORK/$ASSET.tgz"
verify "$WORK/$ASSET.tgz" "$CARGO_AUDIT_SHA256"
tar -xzf "$WORK/$ASSET.tgz" -C "$WORK" "$ASSET/cargo-audit" || die "$ASSET.tgz has no $ASSET/cargo-audit"
mkdir -p "$CARGO_BIN"
install -m 0755 "$WORK/$ASSET/cargo-audit" "$CARGO_BIN/cargo-audit"

# "The step passed" must mean "this version is on PATH", not "a version line was printed".
GOT=$("$CARGO_BIN/cargo-audit" audit --version 2>&1 || true)
case " $GOT " in
  *" $CARGO_AUDIT_VERSION "*) ;;
  *) die "installed $CARGO_BIN/cargo-audit reports '${GOT:-<nothing>}', expected $CARGO_AUDIT_VERSION" ;;
esac
echo "ci-install-rust-audit: rustup $RUSTUP_VERSION (toolchain from rust-toolchain.toml) + cargo-audit $CARGO_AUDIT_VERSION in $CARGO_BIN"
