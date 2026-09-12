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

## C5 — Runtime identity is uid 1000, gid 1000

**RENEGOTIATED 2026-09-12 by feature 070 (item #421).** This clause previously read *"Runtime identity
is root (uid 0)"*, and said of itself:

> **Explicitly a temporary clause.** It is recorded here so that moving to non-root is a *contract
> change* — one that must be accompanied by a volume ownership migration — rather than an
> innocuous-looking Dockerfile edit.

That is what happened. The clause is **discharged, not deleted**: the temporary state it described has
ended, and the record of why it existed is kept above so the next reader can see that the identity was
chosen twice, deliberately, rather than drifting.

**The migration that accompanied it**: a one-time `chown -R 1000:1000` of the data volume, performed
with the service stopped, for dev and production separately. The production volume
(`observability-langfuse-minio-data`) was measured root-owned and holding real Langfuse data by feature
069's T013 before any of this was written, so the migration was known-necessary rather than precautionary.

**Why the NUMBER is contracted, not merely "non-root"**: a volume is chowned to a number, never to a
name. An identity allocated by `adduser`'s system counter — uid 100 on `alpine:3.24`, measured — can
move when the base image adds a system account, and a moved uid fails exactly like an unmigrated volume,
on a rebuild that changed nothing visible.

**A second clause came with it**: the image must provide a writable `HOME` for that user, because `mc`
writes its config to `$HOME/.mc` and is used by both the `langfuse-minio` healthcheck and the bucket-init
one-shot. See `specs/070-minio-non-root/contracts/runtime-identity.md` clause I2 for the measurement.

**Verification**: `docker run --rm --entrypoint id <image> -u` reports `1000`, asserted in
`.forgejo/workflows/minio-image.yml` before publish; and the container reads and writes a volume
chowned to `1000:1000` that carries pre-existing objects.

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
