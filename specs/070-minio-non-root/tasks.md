# Tasks: MinIO runs as a non-root, explicitly-numbered uid

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Contract**: [contracts/runtime-identity.md](contracts/runtime-identity.md)

Legend: ✅ done · ⏳ blocked on an operator action · Verify RED / Verify GREEN per the tasks-template.

---

## Phase 1 — Establish the premise empirically (done before any edit)

### T001 ✅ Confirm the current image runs as root
`docker run --rm --entrypoint id <image> -u` → `0`. Contract C5 holds as written.

### T002 ✅ Seed a volume the way production was seeded
Ran the current **root** image against a new volume, created the `langfuse` bucket and a real object.
Resulting ownership `0:0`, containing `.minio.sys/` and `langfuse/` — a faithful replica of the
production volume measured by 069's T013.

### T003 ✅ Verify RED — non-root against an unmigrated volume must fail
```
Error: unable to rename (/data/.minio.sys/tmp -> /data/.minio.sys/tmp-old/89b6…)
       file access denied, drive may be faulty, please investigate
exit 1
```
The premise behind this feature is measured, not assumed.

### T004 ✅ Verify RED — the `mc` failure that the backlog item did not list
Healthcheck run verbatim from compose, as uid 1000:
```
mc: <ERROR> Unable to save new mc config. mkdir /.mc: permission denied.   exit=1
```
Root: OK. uid 1000 with a writable config dir: OK. **This is why FR-004 exists**, and why a
chown-plus-`USER` change would have taken the observability stack down.

---

## Phase 2 — The image

### T005 ✅ Create the user, give it a HOME, drop privilege
`infrastructure-as-code/docker/minio/Dockerfile` — explicit uid/gid 1000, `HOME` set, `USER 1000:1000`.
Replaces the "NO `USER` directive" comment block with the reason it is now present.

### T006 ✅ Verify GREEN — end-to-end against a volume with PRE-EXISTING objects
Chowned the seeded volume to `1000:1000` and started the non-root image:

```
uid=1000(minio) gid=1000(minio)
mc ready local                    -> The cluster 'local' is ready
mc mb --ignore-existing …/langfuse -> Bucket created successfully
mc ls local/langfuse              -> trace-0001.txt, trace-0002.txt   (written in the ROOT era)
mc cp … local/langfuse/trace-0003 -> succeeded                        (new NON-ROOT write)
storage errors in log             -> 0
state=running restarts=0
```

Both halves of SC-001 and SC-002 proven, on a volume with pre-existing objects rather than a fresh one.

**Re-run on the REAL from-source build**, not only on a derived image: `docker build` of the edited
Dockerfile produced `minio RELEASE.2025-09-07T16-13-09Z` / `mc RELEASE.2025-08-13T08-35-41Z`, uid `1000`,
`HOME=/home/minio`, a working `/bin/sh` — i.e. contract clauses C1, C2, C3 and the renegotiated C5 all
pass on the artifact CI will publish. RED was re-confirmed on that same image against the unmigrated
volume before migrating it.

### T007 ✅ Confirm compose needs no change
Neither `compose.yaml` nor `compose.prod.yaml` declares `user:`; the healthcheck and bucket-init commands
were run verbatim in T006 and both pass. FR-005 / clause I3 hold.

---

## Phase 3 — The contracts and the guard

### T008 ✅ Renegotiate contract C5 in place
`specs/069-minio-from-source/contracts/image-contract.md` — C5 now states the non-root identity, records
that the temporary clause has been discharged, and names the migration that accompanied it. Not deleted.

### T009 ✅ Update the CI assertion at the cause
`.forgejo/workflows/minio-image.yml` asserted `id -u` is `0` and would have failed on this change — that
is the guard working. It now asserts the contracted uid, so it still fails if the identity regresses or
drifts. Not deleted for being inconvenient.

### T010 ✅ Document the operator migration
`docs/runbooks/prod-control-tower.md` — the dev and prod commands, and the verification that counts
entries not owned by the target uid rather than stat-ing `/data`.

---

## Phase 4 — The operator step (outside CI)

> **The chown must be done with the service STOPPED, as the last step before the non-root image starts.**
> Root bypasses DAC checks, so the running root image keeps working on a `1000:1000` volume (clean
> restart, `mc ready local` ready, new write OK, zero storage errors) — the chown is not disruptive. But
> it does **not persist**: every object the root process writes afterwards is created root-owned again.
> Measured — `find /data ! -user 1000` went from `0` back to `2` after ONE new object. An early chown is
> harmless and buys nothing.

### T011 ⏳ Migrate the **dev** volume
```sh
docker compose --profile observability stop langfuse-minio
docker run --rm -v mcm_langfuse-minio-data:/data alpine:3.24 chown -R 1000:1000 /data
docker run --rm -v mcm_langfuse-minio-data:/data alpine:3.24 sh -c 'find /data ! -user 1000 | wc -l'
```
Confirm the count is `0`. Check the dev volume's real (compose-prefixed) name first — see trap 1 in I4.

### T012 ⏳ Migrate the **production** volume — the merge gate
```sh
docker volume ls | grep -i minio          # confirm the name BEFORE touching anything
docker compose --profile observability stop langfuse-minio
docker run --rm -v observability-langfuse-minio-data:/data alpine:3.24 chown -R 1000:1000 /data
docker run --rm -v observability-langfuse-minio-data:/data alpine:3.24 sh -c 'find /data ! -user 1000 | wc -l'
```
Must report `0`. **Nothing root-owned may run against the volume between this and bringing the stack up
on the new digest** — including the root MinIO itself, which is why step 2 stops it (trap 2 in I4).

There is also a `minio_minio-data` volume on that host from another/older project. Confirm which stack
owns it before touching anything named `minio*`.

### T013 ⏳ Merge, then update the digest pins, then deploy
Merging does **not** deploy: both compose files pin the image by digest (contract C6), so the new image
published by `minio-image` on the push to `main` is consumed by nothing until the pins are updated.

The real gate is the **digest-pin update**, which must not precede T012. Take the digest from the
`minio-image` run's step summary — not a remembered one; two builds of identical source produced
different digests (runs 3115, 3117). Update **both** `compose.yaml` and `compose.prod.yaml`.

### T014 ⏳ Post-deploy confirmation
`langfuse-minio` healthy, `langfuse-web` and `langfuse-worker` up, and a trace visible in the LangFuse
UI written *after* the deploy.
