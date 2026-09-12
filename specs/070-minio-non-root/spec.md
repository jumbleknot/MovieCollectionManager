# Feature Specification: MinIO runs as a non-root, explicitly-numbered uid

**Feature Branch**: `421-minio-non-root`

**Created**: 2026-09-12

**Status**: Draft

**Input**: Backlog item #421 — "Run MinIO as non-root — needs a one-time volume chown and renegotiates
image-contract C5". The direct successor to feature 069, which built MinIO from source but deliberately
kept the image running as **root** (FR-015) to hold every variable but packaging constant.

## Why now

Feature 069 replaced a withdrawn upstream image with one built from source. It kept the runtime identity
at **root**, matching the image it replaced, and recorded that as **contract C5** rather than as a
comment — precisely so that moving to non-root would be a *contract change* rather than an
innocuous-looking Dockerfile edit. This feature is that change.

Three things make it worth doing now rather than later:

1. **MinIO is the last first-party image running as root.** All six others already drop privilege
   (`backend/mc-service`, `agents/movie-assistant`, `frontend/mcm-app`, and the three MCP servers).
   MinIO is the outlier, and it is the one holding production object data.
2. **The blocking prerequisite is resolved.** Feature 069's T013 measured the production volume on
   2026-09-12: `observability-langfuse-minio-data` is root-owned and holds real Langfuse data. The
   migration is a real `chown`, not a no-op, and the measurement no longer has to be guessed at.
3. **Production is healthy on the from-source image**, so this change is no longer stacked behind 069
   landing.

## What the risk actually is

The live volume was created and written by a **root** process. A replacement running as a non-root uid
cannot write to it, and the failure lands on a production redeploy holding real trace data.

**Reproduced, not assumed** (2026-09-12, on a volume seeded by the current root image with a real
`.minio.sys` tree and a real object):

```
$ docker run --user 1000:1000 -v <seeded-volume>:/data <image> server /data
Error: unable to rename (/data/.minio.sys/tmp -> /data/.minio.sys/tmp-old/89b6…)
       file access denied, drive may be faulty, please investigate
```

## The finding that changes the shape of this work

**A `chown` plus a `USER` directive is NOT sufficient.** Item #421's checklist is incomplete, and the
missing piece fails in a way that does not point at its cause.

`mc` — the MinIO client — writes its configuration to `$HOME/.mc` on first use. The runtime image
creates no home directory, so a non-root process gets `HOME=/`, which is root-owned and mode 755:

```
$ docker exec <non-root container> mc ready local
mc: <ERROR> Unable to save new mc config. mkdir /.mc: permission denied.   exit=1
```

`mc` is used in **two load-bearing places** in both the dev and production observability stacks:

| Where | Command | Consequence of failure |
| --- | --- | --- |
| `langfuse-minio` healthcheck | `mc ready local` | The container never reports healthy. `langfuse-web` and `langfuse-worker` both declare `depends_on: langfuse-minio: condition: service_healthy`, so **neither ever starts** |
| `langfuse-minio-init` | `mc alias set` / `mc mb` | The `langfuse` bucket is never created; LangFuse v3 does not auto-create it and ingestion fails with "Failed to upload JSON to S3" |

So a change that did only the two things the backlog item lists would take the observability stack down,
and the visible symptom would be "minio unhealthy" — not "permissions". Measured, with the healthcheck
run verbatim from compose: **OK as root, exit 1 as uid 1000, OK as uid 1000 with a writable config
dir.**

## User scenarios

### US-1 — A production redeploy onto the migrated volume keeps every existing trace (P1)

As the operator, when I deploy the non-root image onto the migrated production volume, the service
starts, every object written during the root era is still readable, and new writes succeed.

**Acceptance**: after the migration, the container reaches healthy, objects written before it are
listable and readable, and a new write succeeds — verified against a volume with **pre-existing
objects**, never a fresh one.

### US-2 — The stack comes up without the operator touching `mc` (P1)

As the operator, I do not have to change compose, the healthcheck, or the init container. The image
carries whatever `mc` needs to run as a non-root user.

**Acceptance**: `compose.yaml` and `compose.prod.yaml` are **unchanged** by this feature, and both the
healthcheck and bucket-init commands work verbatim.

### US-3 — The identity cannot drift on a rebuild (P1)

As the person who ran the one-time `chown`, the uid I chowned to remains the uid the image runs as,
across every future rebuild.

**Acceptance**: the uid is an explicit number in the Dockerfile, and CI asserts it.

## Requirements

- **FR-001**: The runtime image MUST run as a non-root user.
- **FR-002**: The uid and gid MUST be **explicit integers** in the Dockerfile, not allocated by
  `adduser`'s system counter. Measured on `alpine:3.24`, the sibling images' idiom
  (`adduser -S <name>`) yields **uid 100 / gid 101** — a counter-allocated value that can move if the
  base image later adds a system account. The six stateless first-party images can afford that; a
  service whose data volume has been chowned to a specific number cannot. A drifted uid would fail
  exactly like an un-migrated volume, on a rebuild that changed nothing visible.
- **FR-003**: The chosen identity is **uid 1000, gid 1000** — see `contracts/runtime-identity.md` for
  the reasoning and the alternatives rejected.
- **FR-004**: The image MUST provide a writable `HOME` for that user, so `mc` can write its config.
  This is what makes the healthcheck and bucket-init work unchanged (see "the finding" above).
- **FR-005**: Neither `compose.yaml` nor `compose.prod.yaml` may need editing for this change. The
  identity is a property of the image.
- **FR-006**: **Contract C5 of feature 069 MUST be renegotiated in place** —
  `specs/069-minio-from-source/contracts/image-contract.md` — stating the new identity, why the
  temporary clause is being discharged, and what the migration was. It is not deleted and not silently
  edited.
- **FR-007**: The CI assertion in `.forgejo/workflows/minio-image.yml` that `id -u` is `0` MUST be
  **updated at the cause** to assert the new premise, so it still fails if the identity regresses. It
  is not deleted for being inconvenient.
- **FR-008**: The one-time volume migration MUST be documented as an operator step, for **dev and
  production separately**, with its verification.
- **FR-009**: The migration MUST be verified against a volume with **pre-existing objects**. A fresh
  volume passes whatever uid is chosen, which is what makes this easy to get wrong.

## Out of scope

- Changing the base image, the build, the pinned MinIO/mc versions, or anything else feature 069
  settled. This feature changes **identity only**; holding everything else constant is what makes a
  failure attributable, and is the same discipline 069 applied in the other direction.
- Dropping further capabilities, adding a read-only root filesystem, or a seccomp profile. Worth doing,
  separately, once identity is proven.

## The operator dependency, stated precisely

The production `chown` is an **operator action on the production host**, outside CI and outside the
coding environment. Two measured facts make the sequencing far less fragile than it first appears, and
both are recorded here because the obvious framing — *"merging arms a broken deploy"* — is **wrong**:

**1. Merging does not deploy anything.** Both compose files pin the image by **digest** (contract C6),
currently `sha256:4dcaddaac0ab6815…`, which is the root image. Merging triggers `minio-image` on the
push to `main`, which builds and publishes a *new* digest — but nothing consumes it until the compose
pins are updated in a separate commit. **The deploy gate is the digest-pin update, not the merge.**

**2. The chown is non-disruptive and can be done first, independently.** Root bypasses DAC permission
checks, so the *currently running root image* keeps working normally on a volume owned by `1000:1000`.
Measured: after `chown -R 1000:1000`, the root image restarted clean, `mc ready local` reported ready,
a new write succeeded, and there were **zero** storage errors.

So the safe order is:

```
  chown the volume  ──▶  merge  ──▶  minio-image publishes a NEW digest
  (non-disruptive,       (nothing        │
   any time)              deploys)       ▼
                                    update the compose digest pins  ──▶  deploy
                                    ▲
                          THIS is the step that must not precede the chown
```

The chown being safe to do early is what removes the need for a tightly-coupled maintenance window.

## Success criteria

- **SC-001**: On a volume seeded with pre-existing objects by the root image, the non-root image starts,
  reports healthy, reads every pre-existing object, and accepts a new write, with **zero** storage
  errors in its log.
- **SC-002**: The healthcheck and bucket-init commands from compose succeed **verbatim**, with no
  compose change.
- **SC-003**: CI fails if the image's uid is not the contracted value.
- **SC-004**: Contract C5 records the change and the migration rather than being deleted.
