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
