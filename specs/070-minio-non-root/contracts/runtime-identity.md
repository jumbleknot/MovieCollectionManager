# Contract: MinIO runtime identity

Supersedes clause **C5** of `specs/069-minio-from-source/contracts/image-contract.md`, which is
renegotiated in place rather than deleted.

---

## I1 — The image runs as uid 1000, gid 1000

Explicit integers in the Dockerfile. Not a name resolved at build time, not a value allocated by
`adduser`'s system counter.

**Why the number is contracted, not just "non-root".** A data volume is chowned to a *number*; the
kernel never sees the name. If the uid the image runs as can move, the volume that was migrated for it
stops matching, and the service fails exactly as if the migration had never happened — on a rebuild that
changed nothing anyone would think to look at.

**Measured (2026-09-12, `alpine:3.24`).** The idiom the six sibling first-party images use —
`addgroup -S <name> && adduser -S <name> -G <name>` — resolves to:

```
uid=100(mcservice) gid=101(mcservice)
```

That is a counter-allocated system id. It is fine for the six: they are stateless, so nothing is keyed
to the number. It is **not** fine here.

### Why 1000 specifically

| Candidate | Verdict |
| --- | --- |
| **1000:1000** | **Chosen.** The conventional first non-system uid, what MinIO's own non-root guidance uses (`--user 1000:1000`), and outside the system range `adduser -S` allocates from — so it cannot collide with an account the base image adds later. |
| `100:101` (inherit the sibling idiom) | Rejected: counter-allocated, and the drift it permits is the specific failure this contract exists to prevent. |
| A high arbitrary id (e.g. `10001`) | Rejected: no benefit over 1000 here, and it diverges from the ecosystem convention an operator would expect when reading a `chown` command. |

**Verification**: `docker run --rm --entrypoint id <image> -u` reports `1000`, asserted in
`.forgejo/workflows/minio-image.yml` before the image is published.

---

## I2 — The image provides a writable HOME for that user

`mc` writes its configuration to `$HOME/.mc` on first use. Without a home directory a non-root process
gets `HOME=/`, which is root-owned and mode 755.

**This is load-bearing, not hygiene.** `mc` runs in two places in both observability stacks:

- the `langfuse-minio` **healthcheck** (`mc ready local`) — and `langfuse-web` / `langfuse-worker` both
  gate on `condition: service_healthy`, so a failing healthcheck stops the whole stack;
- the `langfuse-minio-init` one-shot that creates the `langfuse` bucket, which LangFuse v3 does not
  auto-create.

**Measured**, healthcheck run verbatim from compose:

| identity | `mc ready local` |
| --- | --- |
| root (before this change) | `The cluster 'local' is ready` |
| uid 1000, no writable HOME | `mc: <ERROR> Unable to save new mc config. mkdir /.mc: permission denied.` exit 1 |
| uid 1000, writable HOME | `The cluster 'local' is ready` |

A change that added `USER` without this would present as "minio unhealthy", not as a permissions
problem — which is why it is a contract clause rather than an implementation detail.

**Verification**: `docker run --rm --entrypoint sh <image> -c 'mc --version >/dev/null && echo ok'`
runs as the contracted uid and writes a config without error.

---

## I3 — Compose is unchanged

The identity is a property of the image. Neither `compose.yaml` nor `compose.prod.yaml` declares a
`user:` key today, and this feature does not add one.

**Why it is a contract**: putting the uid in compose would split one decision across three files (the
Dockerfile, dev compose, prod compose) and let them drift apart silently. The image is the single place
the identity is stated.

**Verification**: the diff for this feature touches no compose file.

---

## I4 — The data volume is migrated before the image is deployed

A one-time `chown -R 1000:1000` of the data volume, for dev and production **separately**, performed
with the service stopped.

**Why it is a contract**: it is the only step that cannot be done by CI, and doing it in the wrong order
produces a failed production deploy against real data rather than a clean error.

**Two traps, both hit during this work and both recorded so they are not re-learned:**

1. **`docker run -v <name>:/data` CREATES the volume if it does not exist**, and a fresh volume is
   `0:0`. During feature 069's T013 the unprefixed name `langfuse-minio-data` was used; Docker created
   it and reported `0:0`, which read as a successful measurement of the production volume. The real
   name is compose-prefixed: **`observability-langfuse-minio-data`**. *Ownership alone cannot
   distinguish a fresh volume from the real one; ownership plus contents can.*
2. **Nothing root-owned may run against the volume after the chown.** Observed while verifying this
   feature: a root container started after the migration recreated `/data/.minio.sys/tmp` and
   `/data/.minio.sys/tmp/.trash` as `0:0`, and the next non-root start failed with the same
   `unable to rename … file access denied` as an unmigrated volume. The top-level directory still
   reported `1000:1000`, so a top-level `stat` would have called it migrated. **Verify by counting
   entries not owned by the target uid, not by stat-ing `/data`.**

**Verification**:

```sh
docker run --rm -v observability-langfuse-minio-data:/data alpine:3.24 \
  sh -c 'find /data ! -user 1000 | wc -l'      # must be 0
```
