# Contract: the published MinIO image

**Consumers**: `infrastructure-as-code/docker/observability/compose.yaml` and `compose.prod.yaml`.

This is the real interface of this feature. The compose files depend on *this*, not on how the
Dockerfile achieves it — which is what allows the Dockerfile's internals (builder version, build flags,
even the runtime base) to change later without touching the stack.

---

## C1 — Both binaries are present and executable

```
/usr/bin/minio
/usr/bin/mc
```

**Why it is a contract, not an implementation detail**: the server's health check is

```yaml
healthcheck:
  test: ["CMD-SHELL", "mc ready local || exit 1"]
```

which runs `mc` **inside the server container**. An image carrying only the server would start, serve
traffic, and never become healthy — so `depends_on: service_healthy` would hang the whole stack with a
running, working MinIO. This is the single most load-bearing clause here, and the reason the design is
one image rather than two.

**Verification**: `docker run --rm --entrypoint sh <image> -c 'minio --version && mc --version'`

---

## C2 — A shell is available

The health check uses `CMD-SHELL` and the init container uses `/bin/sh -c "… && …"`. The image must
provide `/bin/sh`.

**Why stated explicitly**: this is exactly what a distroless or scratch base would remove. Recording it
as a contract clause means a future base change has to confront it rather than discover it when the
stack stops coming up. If a shell-free base is ever wanted, the health check and init entrypoint must
change **in the same commit**.

**Verification**: covered by C1's verification command, which invokes `sh`.

---

## C3 — Version is reported honestly

`minio --version` and `mc --version` report the upstream release they were built from — not
`DEVELOPMENT`, not empty, not the commit alone.

**Why it is a contract**: the version stamp is injected via generated `ldflags`. A build that omits it
still produces working binaries, so nothing fails at build time — it fails later, subtly, in
version-aware behaviour and in any human trying to work out what is deployed. This clause makes the
omission detectable.

**Verification**: the reported version string equals the pinned `RELEASE.*` tag for each binary.

---

## C4 — Entrypoint composes with the existing command

```
ENTRYPOINT ["minio"]
```

so that the unchanged compose `command: ["server", "/data", "--console-address", ":9001"]` produces
`minio server /data --console-address :9001`.

**Why it is a contract**: it is what lets the compose diff be four image references and nothing else.
An image that baked its own `CMD`, or kept upstream's `docker-entrypoint.sh`, would force the stack to
change shape.

**Verification**: the container's resolved command line matches the above, and the server starts.

---

## C5 — Runtime identity is root (uid 0)

Matching the replaced image, whose published config carries no `User`.

**Why it is a contract**: the live `langfuse-minio-data` volume is root-owned. An image running as any
other uid cannot write to it, and that failure surfaces on a production redeploy against real data.

**Explicitly a temporary clause.** It is recorded here so that moving to non-root is a *contract
change* — one that must be accompanied by a volume ownership migration — rather than an innocuous-looking
Dockerfile edit.

**Verification**: `docker run --rm <image> id -u` reports `0`, and the container writes to a
root-owned bind mount.

---

## C6 — Addressed by digest

Every reference in compose carries `@sha256:`.

**Why it is a contract**: the feature exists because a mutable upstream reference was withdrawn. A
tag-only reference to our own registry reintroduces the same class of problem in a smaller blast
radius.

**Verification**: no reference to this image anywhere in `infrastructure-as-code/**` lacks a digest.

---

## C7 — What this contract deliberately does NOT promise

- **Not** a specific runtime base. Alpine today; a future change may differ, provided C2 is satisfied
  or renegotiated.
- **Not** a specific builder or Go version. That is an input we choose and expect to move — moving it
  is how we respond to a stdlib CVE.
- **Not** binary-identical reproducibility against upstream's own published images. Those are gone, and
  we build with a newer toolchain by design.
- **Not** any behaviour of the MinIO server itself. Upstream's behaviour at the pinned release is what
  it is; this contract covers packaging only.
