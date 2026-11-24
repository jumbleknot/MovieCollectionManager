#!/usr/bin/env bash
# Install the PINNED Trivy release from its GitHub release assets — the one recipe shared by app-ci's
# app-image-scan, infra-image-scan and cd-deploy, so the PR gates and the deploy scan cannot drift.
#
#   bash scripts/ci-install-trivy.sh <bindir>
#
# THE PIN LIVES IN THIS FILE (item #1127) — one (version, sha256) pair per platform, as for rustup and
# cargo-audit. It used to be a TRIVY_VERSION in each of three workflows, checked against the
# `trivy_<v>_checksums.txt` downloaded FROM THE SAME RELEASE: that catches a corrupt download but not
# a compromised release, whose attacker controls both files. Now the tarball must match the sha256
# committed HERE, and the publisher's checksums file must agree with it too — two independent sources.
#
# Renovate moves TRIVY_VERSION alone; TRIVY_SHA256_FOR names the version the checksums were taken
# for, so a bump without new checksums fails here at run time AND offline in
# renovate-workflow.guard.test.mjs. `node scripts/refresh-pinned-sha256.mjs --write` refreshes them
# (download, hash, compare with the publisher's checksums file).
#
# WHY NOT trivy's contrib/install.sh. Measured on PR #929 (runs 6696 and 6702, 2026-11-04): the
# install step failed twice with NO error, its last line "found version: 0.76.1". The script fetches
# the tarball from get.trivy.dev (a redirector, NOT GitHub), and http_download_curl logs a non-200
# status at DEBUG level and returns 1, which `set -e` turns into a silent exit — so what failed and
# why was unrecoverable, and the same command passed 3/3 an hour later. It was also a fetched script
# piped into sh. This downloads the two assets itself and names the URL and curl's error on failure.
#
# --retry-all-errors because the observed failures were transient; the installed binary must report
# the pinned version, so "the step passed" means "this version is on PATH", not "a version line was
# printed".
#
# Test seams (scripts/__tests__/ci-install-trivy.test.mjs, which runs a copy of this offline against
# file:// with the pin lines rewritten — there is deliberately NO environment override for the pin):
#   MCM_TRIVY_BASE_URL  release-asset base, default https://github.com/aquasecurity/trivy/releases/download
#   MCM_TRIVY_PLATFORM  asset platform suffix, default from uname (Linux-64bit / Linux-ARM64)
#   MCM_TRIVY_RETRY_DELAY  seconds between curl retries, default 5
set -euo pipefail

TRIVY_VERSION=v0.76.2
TRIVY_SHA256_FOR=v0.76.2
TRIVY_SHA256_LINUX_64BIT=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf
TRIVY_SHA256_LINUX_ARM64=ab9d51f86e6a5fb936f605faff6b593ac51bc378fff4d3e8b9d58358b9c367c3

die() { echo "ci-install-trivy: $*" >&2; exit 1; }
[ "$#" -eq 1 ] || { echo "usage: $0 <bindir>   (the version pin lives in this file)" >&2; exit 2; }

BINDIR=$1
TAG=$TRIVY_VERSION
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "TRIVY_VERSION '$TAG' is not a vX.Y.Z tag"
VERSION=${TAG#v}
[ "$TRIVY_SHA256_FOR" = "$TRIVY_VERSION" ] ||
  die "TRIVY_VERSION is $TRIVY_VERSION but the TRIVY_SHA256_* checksums were taken for $TRIVY_SHA256_FOR — run: node scripts/refresh-pinned-sha256.mjs --write"

if [ -n "${MCM_TRIVY_PLATFORM:-}" ]; then
  PLATFORM=$MCM_TRIVY_PLATFORM
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) PLATFORM=Linux-64bit ;;
    Linux-aarch64 | Linux-arm64) PLATFORM=Linux-ARM64 ;;
    *) die "no Trivy release asset for $(uname -s)-$(uname -m)" ;;
  esac
fi
case "$PLATFORM" in
  Linux-64bit) PINNED=$TRIVY_SHA256_LINUX_64BIT ;;
  Linux-ARM64) PINNED=$TRIVY_SHA256_LINUX_ARM64 ;;
  *) die "no pinned sha256 for platform $PLATFORM — add a TRIVY_SHA256_* line for it" ;;
esac
[[ "$PINNED" =~ ^[0-9a-f]{64}$ ]] || die "the pinned sha256 for $PLATFORM is not a sha256: '$PINNED'"

BASE="${MCM_TRIVY_BASE_URL:-https://github.com/aquasecurity/trivy/releases/download}/${TAG}"
TARBALL="trivy_${VERSION}_${PLATFORM}.tar.gz"
CHECKSUMS="trivy_${VERSION}_checksums.txt"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fetch() {
  local name=$1 rc=0
  curl -fsSL --proto '=https,file' --retry 3 --retry-all-errors --retry-delay "${MCM_TRIVY_RETRY_DELAY:-5}" \
    --connect-timeout 20 -o "$WORK/$name" "$BASE/$name" || rc=$?
  [ "$rc" -eq 0 ] || die "download failed (curl exit $rc, after retries): $BASE/$name"
  echo "ci-install-trivy: downloaded $name ($(wc -c <"$WORK/$name") bytes)"
}

fetch "$TARBALL"
fetch "$CHECKSUMS"

# 1. The bytes match the sha256 committed in this file.
GOT_SHA=$(sha256sum "$WORK/$TARBALL" | cut -d' ' -f1)
[ "$GOT_SHA" = "$PINNED" ] || die "checksum mismatch for $TARBALL: pinned $PINNED, downloaded $GOT_SHA"

# 2. The publisher's checksums file agrees. Exactly one line for this asset — grep alone would
#    accept a .sigstore.json or a second match.
PUBLISHED=$(awk -v f="$TARBALL" '$2 == f { print $1; n++ } END { exit n == 1 ? 0 : 1 }' "$WORK/$CHECKSUMS") \
  || die "$CHECKSUMS has no single entry for $TARBALL"
[ "$PUBLISHED" = "$PINNED" ] || die "$CHECKSUMS says $PUBLISHED for $TARBALL, but the pin says $PINNED — the release changed under the pin"
echo "ci-install-trivy: sha256 verified for $TARBALL (pinned, and matching $CHECKSUMS)"

tar -xzf "$WORK/$TARBALL" -C "$WORK" trivy || die "$TARBALL has no 'trivy' binary"
mkdir -p "$BINDIR"
install -m 0755 "$WORK/trivy" "$BINDIR/trivy"

GOT=$("$BINDIR/trivy" --version 2>&1 | awk '/^Version:/ { print $2; exit }')
[ "$GOT" = "$VERSION" ] || die "installed $BINDIR/trivy reports version '${GOT:-<none>}', expected $VERSION"
echo "ci-install-trivy: installed Trivy $VERSION at $BINDIR/trivy"
