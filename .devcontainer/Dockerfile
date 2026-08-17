# .devcontainer/Dockerfile — feature 038 (full dev-container toolchain)
#
# The THIN substitution seam. Its ONLY job is to let devcontainer.json parametrize the base
# image via `build.args` — because the dev-container spec's top-level `image` property is NOT
# substitution-eligible ("variables are not supported in properties used during image build
# time, as this would prevent pre-building"), but `build.args` IS (research D2, decision pinned).
#
# So the host-free, digest-pinned reference to the prebuilt toolchain image flows in as
# BASE_IMAGE = ${localEnv:MCM_DEVCONTAINER_IMAGE:mcm-devcontainer} (set in devcontainer.json).
# The default `mcm-devcontainer` (Docker reads as :latest) resolves to the locally-built image
# (scripts/build-devcontainer-image.mjs) so a bare `devcontainer up` with no env still works
# offline. NOTE: the local fallback tag is COLON-FREE because the devcontainer ${localEnv:VAR:default}
# parser truncates a default at its first colon (see devcontainer.json). The forge host literal
# NEVER enters git — it lives only in the gitignored local env (FR-010, topology-scrub). All real
# setup is in toolchain.Dockerfile; this file must stay minimal.
ARG BASE_IMAGE=mcm-devcontainer
FROM ${BASE_IMAGE}

# ── 060: align the container user's UID with the VM user's (recreate defect #10) ───────────────
#
# This file is documented above as "must stay minimal", and this layer is a DELIBERATE, guarded
# exception. Three cheaper options were tried first and are recorded so nobody repeats them:
#
#   1. `"updateRemoteUserUID": true` — the dev-container spec's own answer. Set explicitly and
#      REBUILT: coder stayed 1001. It does not engage on this path. (Left set anyway: harmless, and
#      it becomes correct if a future CLI honours it.)
#   2. A chown-based repair (fix-workspace-ownership.sh). The mismatch is SYMMETRIC — chowning the
#      tree to the container user makes the VM user fail, and vice versa. Measured in one run:
#      "container git write: OK / VM git write: FAILED". A see-saw, not a fix.
#   3. Renumbering in toolchain.Dockerfile, which is the RIGHT home. It invalidates every layer
#      after the useradd — Rust, uv, the Android SDK, cargo install — and the VM's Docker disk is
#      49 GB and non-enlargeable, sitting at 86% used. It would ENOSPC. Do this when the toolchain
#      image is next rebuilt on a machine with room, and then delete this layer.
#
# THE PROBLEM: node:24-bookworm ships `node` at uid 1000, so toolchain.Dockerfile's plain `useradd`
# puts `coder` on 1001 — while the VM user that owns /workspaces is uid 1000. Every file written by
# one is unwritable by the other, and git fails deep on object writes with errors that read like
# repository corruption ("owned by node, not coder").
#
# Guarded so it is a no-op once the toolchain image itself puts coder at 1000.
USER root
RUN set -eux; \
    if [ "$(id -u coder)" != "1000" ]; then \
      # Move `node` out of the way rather than deleting it — something may still reference the name,
      # and renumbering is reversible where a userdel is not.
      usermod  -u 1100 node 2>/dev/null || true; \
      groupmod -g 1100 node 2>/dev/null || true; \
      # Re-home any file still carrying node's old ids, or they would silently become coder's.
      find / -xdev -uid 1000 -exec chown -h 1100 {} + 2>/dev/null || true; \
      find / -xdev -gid 1000 -exec chgrp -h 1100 {} + 2>/dev/null || true; \
      # Now the ids are free for coder. usermod fixes $HOME itself; the finds catch everything else.
      usermod  -u 1000 coder; \
      groupmod -g 1000 coder; \
      find / -xdev -uid 1001 -exec chown -h 1000 {} + 2>/dev/null || true; \
      find / -xdev -gid 1001 -exec chgrp -h 1000 {} + 2>/dev/null || true; \
    fi; \
    # Fail the BUILD rather than ship a container that reproduces the bug.
    test "$(id -u coder)" = "1000"; \
    test "$(id -g coder)" = "1000"
USER coder
