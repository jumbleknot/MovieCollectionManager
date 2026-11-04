#!/usr/bin/env bash
# Install a PINNED Trivy release from its GitHub release assets — the one recipe shared by app-ci's
# app-image-scan, infra-image-scan and cd-deploy, so the PR gates and the deploy scan cannot drift.
#
#   bash scripts/ci-install-trivy.sh <vX.Y.Z> <bindir>
#
# WHY NOT trivy's contrib/install.sh. Measured on PR #929 (runs 6696 and 6702, 2026-11-04): the
# install step failed twice with NO error, its last line "found version: 0.76.1". The script fetches
# the tarball from get.trivy.dev (a redirector, NOT GitHub), and http_download_curl logs a non-200
# status at DEBUG level and returns 1, which `set -e` turns into a silent exit — so what failed and
# why was unrecoverable, and the same command passed 3/3 an hour later. It was also a fetched script
# piped into sh. This downloads the two assets itself and names the URL and curl's error on failure.
#
# --retry-all-errors because the observed failures were transient; the checksum is verified because
# a retried download must still be the right bytes; the installed binary must report the pinned
# version, so "the step passed" means "this version is on PATH", not "a version line was printed".
#
# Test seams (scripts/__tests__/ci-install-trivy.test.mjs, which runs this offline against file://):
#   MCM_TRIVY_BASE_URL  release-asset base, default https://github.com/aquasecurity/trivy/releases/download
#   MCM_TRIVY_PLATFORM  asset platform suffix, default from uname (Linux-64bit / Linux-ARM64)
#   MCM_TRIVY_RETRY_DELAY  seconds between curl retries, default 5
set -euo pipefail

die() { echo "ci-install-trivy: $*" >&2; exit 1; }
[ "$#" -eq 2 ] || { echo "usage: $0 <vX.Y.Z> <bindir>" >&2; exit 2; }

TAG=$1
BINDIR=$2
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "ci-install-trivy: '$TAG' is not a vX.Y.Z tag" >&2; exit 2; }
VERSION=${TAG#v}

if [ -n "${MCM_TRIVY_PLATFORM:-}" ]; then
  PLATFORM=$MCM_TRIVY_PLATFORM
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) PLATFORM=Linux-64bit ;;
    Linux-aarch64 | Linux-arm64) PLATFORM=Linux-ARM64 ;;
    *) die "no Trivy release asset for $(uname -s)-$(uname -m)" ;;
  esac
fi

BASE="${MCM_TRIVY_BASE_URL:-https://github.com/aquasecurity/trivy/releases/download}/${TAG}"
TARBALL="trivy_${VERSION}_${PLATFORM}.tar.gz"
CHECKSUMS="trivy_${VERSION}_checksums.txt"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fetch() {
  local name=$1 rc=0
  curl -fsSL --retry 3 --retry-all-errors --retry-delay "${MCM_TRIVY_RETRY_DELAY:-5}" --connect-timeout 20 \
    -o "$WORK/$name" "$BASE/$name" || rc=$?
  [ "$rc" -eq 0 ] || die "download failed (curl exit $rc, after retries): $BASE/$name"
  echo "ci-install-trivy: downloaded $name ($(wc -c <"$WORK/$name") bytes)"
}

fetch "$TARBALL"
fetch "$CHECKSUMS"

# Exactly one line for this asset — grep alone would accept a .sigstore.json or a second match.
WANT=$(awk -v f="$TARBALL" '$2 == f { print; n++ } END { exit n == 1 ? 0 : 1 }' "$WORK/$CHECKSUMS") \
  || die "$CHECKSUMS has no single entry for $TARBALL"
(cd "$WORK" && printf '%s\n' "$WANT" | sha256sum -c --status -) \
  || die "checksum mismatch for $TARBALL (expected: ${WANT%% *})"
echo "ci-install-trivy: sha256 verified for $TARBALL"

tar -xzf "$WORK/$TARBALL" -C "$WORK" trivy || die "$TARBALL has no 'trivy' binary"
mkdir -p "$BINDIR"
install -m 0755 "$WORK/trivy" "$BINDIR/trivy"

GOT=$("$BINDIR/trivy" --version 2>&1 | awk '/^Version:/ { print $2; exit }')
[ "$GOT" = "$VERSION" ] || die "installed $BINDIR/trivy reports version '${GOT:-<none>}', expected $VERSION"
echo "ci-install-trivy: installed Trivy $VERSION at $BINDIR/trivy"
