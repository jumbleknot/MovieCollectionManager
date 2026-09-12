# MinIO server + mc client, built from source (feature 069, item #420).
#
# WHY THIS EXISTS. MinIO deleted `minio/minio` and `minio/mc` from Docker Hub on 2026-09-11 — both
# repositories return 404 while the `minio` org keeps its other 20 repos, so this was a targeted
# withdrawal, not an outage. Switching registry is not a fix: MinIO moved the community edition to
# source-only distribution in October 2025 and stopped publishing images anywhere, so the copies still
# on quay.io are frozen at the same point. The proof is in the version numbers — the newest SOURCE tag
# is RELEASE.2025-10-15T17-29-55Z, titled "Security/CVE", and no registry ever received it.
#
# Building from source also takes back a decision that was upstream's: the Go toolchain. CVE-2025-68121
# (Go stdlib) sits un-dischargeable in security/infra-images/allowlist.yaml against postgres, mongodb
# and vault precisely because those images ship an old stdlib. Here it is a build input we pin.
#
# ONE IMAGE, BOTH BINARIES — required, not merely convenient. The stack's health check is
# `["CMD-SHELL", "mc ready local || exit 1"]`, which runs `mc` INSIDE the server container, exactly as
# upstream's image allowed. An image carrying only the server would start, serve traffic, and never
# become healthy — so everything gated on `service_healthy` would wait for ever on a working MinIO.
#
# The full reasoning, measured rather than asserted, is in specs/069-minio-from-source/research.md.
# The interface this image owes the stack is specs/069-minio-from-source/contracts/image-contract.md.

# ── Pinned inputs ─────────────────────────────────────────────────────────────────────────────────
# Source is pinned by release tag AND commit SHA. The tag alone would be insufficient: a git tag is
# mutable, and "the upstream publisher withdraws or moves what we depend on" is not hypothetical here
# — it is the reason this file exists. The build asserts the tag resolves to the pinned commit.
#
# NOTE for whoever bumps these: both tags are ANNOTATED. `git rev-parse <tag>` yields the tag object,
# not the commit; dereference with `<tag>^{commit}` or the commit pinned below will never match.
#
# NAMED `*_TAG`, NOT `*_RELEASE`, deliberately. Upstream's buildscripts/gen-ldflags.go reads env vars
# literally called MINIO_RELEASE and MC_RELEASE — but they hold the release PREFIX ("RELEASE"), not the
# tag. An ARG of the same name would shadow them and silently reintroduce the DEVELOPMENT.GOGET bug
# fixed below. Keep these names distinct from upstream's.
ARG MINIO_TAG=RELEASE.2025-09-07T16-13-09Z
ARG MINIO_COMMIT=07c3a429bfed433e49018cb0f78a52145d4bedeb
ARG MC_TAG=RELEASE.2025-08-13T08-35-41Z
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096

# ── Builder ───────────────────────────────────────────────────────────────────────────────────────
# One toolchain for both modules. minio declares `go 1.24.0 / toolchain go1.24.2`, mc declares
# `go 1.23.0 / toolchain go1.23.10`; a local toolchain newer than both satisfies both. Deliberately the
# newest available rather than matching upstream — see the stdlib note above.
FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build

# git is needed at BUILD time, not just to fetch: upstream's `buildscripts/gen-ldflags.go` shells out
# to `git log` to stamp the commit id and build time into the binary. A source tarball would compile
# but produce a binary that misreports itself — see contract C3.
RUN apk add --no-cache git

# GOTOOLCHAIN=local pins the compiler to the one in this image. Without it, the `toolchain` directives
# in both go.mod files would make Go DOWNLOAD go1.24.2 / go1.23.10 mid-build — a network fetch inside
# what is supposed to be a hermetic build, and it would hand the stdlib choice back to upstream, which
# is the decision this whole file exists to take back.
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=linux

ARG MINIO_TAG
ARG MINIO_COMMIT
ARG MC_TAG
ARG MC_COMMIT

WORKDIR /src

# Each source is fetched at its tag and then VERIFIED against the pinned commit. A moved tag fails the
# build loudly instead of silently producing a different binary under the same version string.
RUN set -eux; \
    git clone --depth 1 --branch "${MINIO_TAG}" https://github.com/minio/minio.git minio; \
    cd minio; \
    actual="$(git rev-parse HEAD)"; \
    if [ "${actual}" != "${MINIO_COMMIT}" ]; then \
      echo "FATAL: minio ${MINIO_TAG} resolves to ${actual}, expected ${MINIO_COMMIT}." >&2; \
      echo "The upstream tag has MOVED. Do not bypass this — establish why before re-pinning." >&2; \
      exit 1; \
    fi

RUN set -eux; \
    git clone --depth 1 --branch "${MC_TAG}" https://github.com/minio/mc.git mc; \
    cd mc; \
    actual="$(git rev-parse HEAD)"; \
    if [ "${actual}" != "${MC_COMMIT}" ]; then \
      echo "FATAL: mc ${MC_TAG} resolves to ${actual}, expected ${MC_COMMIT}." >&2; \
      echo "The upstream tag has MOVED. Do not bypass this — establish why before re-pinning." >&2; \
      exit 1; \
    fi

# ── The version stamp, and why it is asserted rather than assumed ─────────────────────────────────
# Build flags mirror upstream's Makefile: -trimpath, -tags kqueue, and the GENERATED ldflags stamp.
#
# gen-ldflags.go is fussier than it looks, and getting it wrong is SILENT. It takes the release
# TIMESTAMP as argv[1] — parsed with the layout "2006-01-02T15-04-05Z" — not the RELEASE.* tag, and it
# takes the release PREFIX from the MINIO_RELEASE / MC_RELEASE env vars, defaulting to "DEVELOPMENT".
# On an unparseable argument it PANICS; a panic goes to stderr, so `$(...)` captures empty stdout,
# `--ldflags ""` is a perfectly valid empty flag, and the build SUCCEEDS with no stamp at all.
#
# That is not hypothetical — it is what run 3113 did on the first CI build of this file, producing a
# working binary reporting `minio version DEVELOPMENT.GOGET`. The post-build contract check caught it
# (contract C3), but by then the image existed. So the stamp is now captured into a variable and
# asserted non-empty HERE, at the point of failure, before it can reach an artifact.
#
# `${MINIO_TAG#RELEASE.}` strips the prefix, leaving the timestamp the parser wants.
RUN set -eux; \
    cd /src/minio; \
    ldflags="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${MINIO_TAG#RELEASE.}")"; \
    if [ -z "${ldflags}" ]; then \
      echo "FATAL: gen-ldflags produced nothing for ${MINIO_TAG} — the version stamp would be lost." >&2; \
      echo "It panics on an unparseable version and panics go to stderr, so an empty capture is the" >&2; \
      echo "symptom. Expected argv[1] as a timestamp like 2025-09-07T16-13-09Z." >&2; \
      exit 1; \
    fi; \
    go build -tags kqueue -trimpath --ldflags "${ldflags}" -o /out/minio

RUN set -eux; \
    cd /src/mc; \
    ldflags="$(MC_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${MC_TAG#RELEASE.}")"; \
    if [ -z "${ldflags}" ]; then \
      echo "FATAL: gen-ldflags produced nothing for ${MC_TAG} — the version stamp would be lost." >&2; \
      exit 1; \
    fi; \
    go build -tags kqueue -trimpath --ldflags "${ldflags}" -o /out/mc

# Assert the stamp took, in the BUILDER, before anything is copied into the runtime image. The
# post-build check in the workflow is the backstop; this is the tripwire.
RUN set -eux; \
    /out/minio --version | grep -q "${MINIO_TAG}" \
      || { echo "FATAL: minio reports '$(/out/minio --version)', expected ${MINIO_TAG}" >&2; exit 1; }; \
    /out/mc --version | grep -q "${MC_TAG}" \
      || { echo "FATAL: mc reports '$(/out/mc --version)', expected ${MC_TAG}" >&2; exit 1; }

# ── Runtime ───────────────────────────────────────────────────────────────────────────────────────
# Same lineage AND the same digest as backend/mc-service, so Renovate moves one thing.
#
# Alpine rather than distroless, deliberately. The big security win of this feature is choosing our own
# Go toolchain, and that applies on any base; distroless would additionally remove the apk layer, at
# the cost of rewriting the health check and the bucket-init entrypoint on a service holding live
# production data. The image must provide /bin/sh — see contract C2 before changing this.
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS runtime

# ca-certificates so the server can reach external endpoints (notification targets, STS) over TLS.
RUN apk add --no-cache ca-certificates

COPY --from=build /out/minio /usr/bin/minio
COPY --from=build /out/mc /usr/bin/mc

# NO `USER` directive — the image runs as root, matching the upstream image it replaces, whose
# published config carries no User. This is load-bearing, not an oversight: the live
# `langfuse-minio-data` volume was created by that root process, and a non-root uid could not write to
# it. Moving to non-root is a deliberate follow-up requiring a one-time volume chown; it is a CHANGE TO
# CONTRACT C5, not an innocuous Dockerfile edit.
#
# NO `CMD` — compose supplies `["server", "/data", "--console-address", ":9001"]`, and duplicating it
# here would split one decision across two files. Upstream's docker-entrypoint.sh is deliberately not
# reproduced either: it exists to translate MINIO_*_FILE secret variants and to drop privileges to
# MINIO_USERNAME, and this stack uses neither.
ENTRYPOINT ["minio"]
