#!/usr/bin/env bash
# Install the PINNED Maestro CLI into a job-private dir (item #1147).
#
#   bash scripts/ci-install-maestro.sh <dir>
#
# It lays the release's maestro/ tree out as <dir>/bin/maestro and <dir>/lib/*.jar, and creates
# <dir>/home, Maestro's job-private state home (item #1152). The caller adds <dir>/bin to $GITHUB_PATH,
# writes MAESTRO_OPTS=-Duser.home=<dir>/home and MCM_MAESTRO_HOME=<dir>/home to $GITHUB_ENV, and removes
# <dir> in an `if: always()` step.
#
# WHY user.home, not an output flag (item #1152). The CLI's state paths all come from the JVM's
# user.home, checked by disassembling the 2.12.1 jars: ~/.maestro/tests (TestDebugReporter, one dir per
# flow per run, never pruned on the host; 7.2G by 2026-11-26), ~/.maestro/deps (Unpacker),
# ~/.maestro/sessions (SessionStore) and ~/.maestro/analytics.json. --test-output-dir and --debug-output
# move only the first. MAESTRO_OPTS is read by bin/maestro alone, so no other JVM in the job (Gradle's
# APK build) sees it; JAVA_TOOL_OPTIONS would reach them all.
#
# <dir>/home/.android is a symlink to the real ~/.android. dadb, Maestro's adb client, reads its key
# from user.home/.android/adbkey and GENERATES a new pair when that is missing (seen locally with a
# bare user.home). The link keeps the one key adb already uses, and keeps it out of <dir>. Maestro only
# reads there, as it did before.
#
# WHY NOT the vendor installer (curl https://get.maestro.mobile.dev | bash). app-e2e runs on the shared
# host runner (`runs-on: kvm`, the `ci` user). That installer installs into ~/.maestro by default.
# Worse, whenever `maestro` is not already on PATH, which is every CI run, it APPENDS
# `export PATH=$PATH:$HOME/.maestro/bin` to ~/.bashrc and ~/.zshrc. By 2026-11-26 each held 644 copies.
# It was also fetched code piped into bash. This downloads the one release asset itself and checks it.
#
# The pin is a (version, sha256) pair in THIS file, the same shape as Trivy, Compose, rustup and
# cargo-audit (item #1127). It used to be a MAESTRO_VERSION in app-ci.yml (item #224). Renovate moves
# MAESTRO_VERSION alone (customManagers in renovate.json, tags `cli-<v>`). MAESTRO_SHA256_FOR names the
# version the checksum was taken for, so a bump without a new checksum fails here and offline in
# renovate-workflow.guard.test.mjs. To refresh the checksum, run
# `node scripts/refresh-pinned-sha256.mjs --write`. It verifies it against the release's checksums_sha256.txt.
#
# scripts/ci-maestro-debug.sh, ci-mobile-lib.sh and ci-failure-digest.mjs read run output from
# ${MCM_MAESTRO_HOME:-$HOME}/.maestro/tests.
#
# Test seams (scripts/__tests__/ci-install-maestro.test.mjs, offline against file://):
#   MCM_MAESTRO_BASE_URL     release-asset base, default https://github.com/mobile-dev-inc/maestro/releases/download
#   MCM_MAESTRO_RETRY_DELAY  seconds between curl retries, default 5
set -euo pipefail

MAESTRO_VERSION=2.12.1
MAESTRO_SHA256_FOR=2.12.1
MAESTRO_SHA256=54dbb0716425626604973cbb374c585ca30272375d9ce15177a1152765ddd9d7

die() { echo "ci-install-maestro: $*" >&2; exit 1; }
[ "$#" -eq 1 ] || { echo "usage: $0 <dir>   (the version pin lives in this file)" >&2; exit 2; }

DEST=$1
[[ "$MAESTRO_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "MAESTRO_VERSION '$MAESTRO_VERSION' is not an X.Y.Z version"
[ "$MAESTRO_SHA256_FOR" = "$MAESTRO_VERSION" ] ||
  die "MAESTRO_VERSION is $MAESTRO_VERSION but MAESTRO_SHA256 was taken for $MAESTRO_SHA256_FOR — run: node scripts/refresh-pinned-sha256.mjs --write"
command -v unzip >/dev/null 2>&1 || die "unzip is not installed"

URL="${MCM_MAESTRO_BASE_URL:-https://github.com/mobile-dev-inc/maestro/releases/download}/cli-$MAESTRO_VERSION/maestro.zip"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

rc=0
curl -fsSL --proto '=https,file' --retry 3 --retry-all-errors --retry-delay "${MCM_MAESTRO_RETRY_DELAY:-5}" \
  --connect-timeout 20 -o "$WORK/maestro.zip" "$URL" || rc=$?
[ "$rc" -eq 0 ] || die "download failed (curl exit $rc, after retries): $URL"

printf '%s  %s\n' "$MAESTRO_SHA256" "$WORK/maestro.zip" | sha256sum -c --status - ||
  die "checksum mismatch for maestro.zip (expected $MAESTRO_SHA256, got $(sha256sum "$WORK/maestro.zip" | cut -d' ' -f1))"
echo "ci-install-maestro: sha256 verified for maestro.zip $MAESTRO_VERSION"

unzip -q "$WORK/maestro.zip" -d "$WORK/x" || die "maestro.zip did not unpack"
[ -x "$WORK/x/maestro/bin/maestro" ] || die "maestro.zip has no executable maestro/bin/maestro"
# Name the version from the archive's own jar. Running `maestro --version` would start the CLI, and
# the CLI writes its state under ~/.maestro on start: exactly the shared home this script avoids.
[ -f "$WORK/x/maestro/lib/maestro-cli-$MAESTRO_VERSION.jar" ] ||
  die "maestro.zip does not carry maestro-cli-$MAESTRO_VERSION.jar — it is not the pinned release"

rm -rf "$DEST/bin" "$DEST/lib" "$DEST/home"
mkdir -p "$DEST/home"
cp -r "$WORK/x/maestro/." "$DEST/"
ln -s "$HOME/.android" "$DEST/home/.android"
echo "ci-install-maestro: Maestro $MAESTRO_VERSION in $DEST/bin, state home $DEST/home"
