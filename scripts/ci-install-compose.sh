#!/usr/bin/env bash
# Install the PINNED Docker Compose CLI plugin into a job-private Docker config dir (item #1147).
#
#   bash scripts/ci-install-compose.sh <docker-config-dir>
#
# It lands at <docker-config-dir>/cli-plugins/docker-compose. The caller then writes
# DOCKER_CONFIG=<docker-config-dir> to $GITHUB_ENV, so the CLI loads THIS plugin, and keeps registry
# logins in that dir too, not in the shared ~/.docker.
#
# WHY. Four host-runner (`runs-on: kvm`) jobs curl'd `releases/latest` into ~/.docker/cli-plugins.
# That is the `ci` user's shared home, where every `ci` process loads plugins from, another project's
# runner included. It also shadowed the system plugin in /usr/libexec/docker/cli-plugins. So each run
# took whatever Compose shipped that day, and could replace the binary under a job that was running.
#
# The pin lives in THIS file as a (version, sha256) pair per platform, the same shape as Trivy, rustup
# and cargo-audit (item #1127). Renovate moves COMPOSE_VERSION alone (customManagers in renovate.json).
# COMPOSE_SHA256_FOR names the version the checksums were taken for, so a bump without new checksums
# fails here at run time and offline in renovate-workflow.guard.test.mjs. To refresh the checksums, run
# `node scripts/refresh-pinned-sha256.mjs --write`. It verifies each against the release's checksums.txt.
#
# Test seams (scripts/__tests__/ci-install-compose.test.mjs, offline against file://; there is
# deliberately NO environment override for the pin):
#   MCM_COMPOSE_BASE_URL     release-asset base, default https://github.com/docker/compose/releases/download
#   MCM_COMPOSE_PLATFORM     asset suffix, default from uname (linux-x86_64 / linux-aarch64)
#   MCM_COMPOSE_RETRY_DELAY  seconds between curl retries, default 5
set -euo pipefail

COMPOSE_VERSION=v5.8.0
COMPOSE_SHA256_FOR=v5.8.0
COMPOSE_SHA256_LINUX_X86_64=b8840f5008c447f41fce0a57ae3adeab42c89b1eb6e6012524bcabbfb4ffbaf6
COMPOSE_SHA256_LINUX_AARCH64=1a9c918b2fb49b9c87f0018c64b5abd0d30715155e98dc939779fbaee6c414d3

die() { echo "ci-install-compose: $*" >&2; exit 1; }
[ "$#" -eq 1 ] || { echo "usage: $0 <docker-config-dir>   (the version pin lives in this file)" >&2; exit 2; }

CONFIG_DIR=$1
[[ "$COMPOSE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "COMPOSE_VERSION '$COMPOSE_VERSION' is not a vX.Y.Z tag"
[ "$COMPOSE_SHA256_FOR" = "$COMPOSE_VERSION" ] ||
  die "COMPOSE_VERSION is $COMPOSE_VERSION but the COMPOSE_SHA256_* checksums were taken for $COMPOSE_SHA256_FOR — run: node scripts/refresh-pinned-sha256.mjs --write"

if [ -n "${MCM_COMPOSE_PLATFORM:-}" ]; then
  PLATFORM=$MCM_COMPOSE_PLATFORM
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) PLATFORM=linux-x86_64 ;;
    Linux-aarch64 | Linux-arm64) PLATFORM=linux-aarch64 ;;
    *) die "no Compose release asset pinned for $(uname -s)-$(uname -m)" ;;
  esac
fi
case "$PLATFORM" in
  linux-x86_64) SHA256=$COMPOSE_SHA256_LINUX_X86_64 ;;
  linux-aarch64) SHA256=$COMPOSE_SHA256_LINUX_AARCH64 ;;
  *) die "no pinned sha256 for platform '$PLATFORM'" ;;
esac

ASSET="docker-compose-$PLATFORM"
URL="${MCM_COMPOSE_BASE_URL:-https://github.com/docker/compose/releases/download}/$COMPOSE_VERSION/$ASSET"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

rc=0
curl -fsSL --proto '=https,file' --retry 3 --retry-all-errors --retry-delay "${MCM_COMPOSE_RETRY_DELAY:-5}" \
  --connect-timeout 20 -o "$WORK/$ASSET" "$URL" || rc=$?
[ "$rc" -eq 0 ] || die "download failed (curl exit $rc, after retries): $URL"

printf '%s  %s\n' "$SHA256" "$WORK/$ASSET" | sha256sum -c --status - ||
  die "checksum mismatch for $ASSET (expected $SHA256, got $(sha256sum "$WORK/$ASSET" | cut -d' ' -f1))"
echo "ci-install-compose: sha256 verified for $ASSET $COMPOSE_VERSION"

PLUGIN="$CONFIG_DIR/cli-plugins/docker-compose"
mkdir -p "$CONFIG_DIR/cli-plugins"
install -m 0755 "$WORK/$ASSET" "$PLUGIN"

# "The step passed" must mean "this version is installed", not "a version line was printed". The
# plugin binary is run directly, so this needs no Docker CLI and no daemon.
GOT=$("$PLUGIN" version 2>&1 || true)
case " $GOT " in
  *" $COMPOSE_VERSION "* | *" ${COMPOSE_VERSION#v} "*) ;;
  *) die "installed $PLUGIN reports '${GOT:-<nothing>}', expected $COMPOSE_VERSION" ;;
esac
echo "ci-install-compose: Compose $COMPOSE_VERSION in $PLUGIN"
