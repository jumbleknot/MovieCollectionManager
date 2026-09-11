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
# The full reasoning, measured rather than asserted, is in specs/069-minio-from-source/research.md.

# ── Pinned inputs ─────────────────────────────────────────────────────────────────────────────────
# Source is pinned by release tag AND commit SHA. The tag alone would be insufficient: a git tag is
# mutable, and "the upstream publisher withdraws or moves what we depend on" is not hypothetical here
# — it is the reason this file exists. The build asserts the tag resolves to the pinned commit.
#
# NOTE for whoever bumps these: both tags are ANNOTATED. `git rev-parse <tag>` yields the tag object,
# not the commit; dereference with `<tag>^{commit}` or the commit pinned below will never match.
ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z
ARG MINIO_COMMIT=07c3a429bfed433e49018cb0f78a52145d4bedeb
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z
ARG MC_COMMIT=7394ce0dd2a80935aded936b09fa12cbb3cb8096

# Builder: one toolchain for both modules. minio declares `go 1.24.0 / toolchain go1.24.2`, mc declares
# `go 1.23.0 / toolchain go1.23.10`; a local toolchain newer than both satisfies both. Deliberately the
# newest available rather than matching upstream — see the stdlib note above.
FROM golang:1.25-alpine@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59 AS build

# Runtime: same lineage as backend/mc-service, and the same digest, so Renovate moves one thing.
# Alpine rather than distroless deliberately: the health check is `CMD-SHELL "mc ready local"` and the
# bucket-init entrypoint is a `/bin/sh -c` chain, so the image must provide a shell. See
# specs/069-minio-from-source/contracts/image-contract.md clause C2 before changing this.
FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS runtime
