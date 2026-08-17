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

# ── 060: DO NOT put the UID renumber here. It was tried, and it CANNOT work. ───────────────────
#
# The container user must match the VM user's uid (recreate defect #10 — see toolchain.Dockerfile,
# where the fix now lives). Doing it as a thin layer on top of the prebuilt image looks like the
# cheap option and is the one thing that is impossible:
#
#   A UID renumber changes the metadata of EVERY file it touches, and in an overlay filesystem
#   changing a file's metadata COPIES THAT FILE UP into the new layer. So a "thin" renumber layer
#   is not thin — it duplicates the entire ~13 GB image. Measured 2026-08-17: the build died in
#   `exporting layers` with
#       no space left on device … /opt/android-sdk/system-images/android-34/…/system.img
#   on a 49 GB disk. Even with room it would permanently DOUBLE the image size, and the copy-up cost
#   would be paid on every rebuild.
#
# The same disk exhaustion is the most likely cause of the earlier `docker-outside-of-docker`
# feature install failing with exit 100, which reads as an apt fault and is not one.
#
# Two other approaches were also tried and rejected — recorded so nobody repeats them:
#   • `"updateRemoteUserUID": true` (the dev-container spec's own mechanism). Set explicitly and
#     rebuilt: coder stayed 1001. It does not engage on this path.
#   • A chown-based repair. The mismatch is SYMMETRIC: chowning the tree to the container user makes
#     the VM user fail and vice versa — measured in a single run as
#     "container git write: OK / VM git write: FAILED". A see-saw, not a fix.
#
# The fix belongs in toolchain.Dockerfile, where the user is created and the copy-up is paid once,
# at image build time, on a machine with disk.
