# Contract: RustFS object-store service (every instance)

Applies to `langfuse-rustfs` (dev `observability/compose.yaml`, prod `observability/compose.prod.yaml`),
`mcm-bff-backup-rustfs` (`backups/compose.yaml`) and the host-managed Nx-cache store
(`/home/prod/rustfs/compose.yaml`, documented in `docs/runbooks/Server-Setup-Runbook.md` Phase 8).

Supersedes `specs/069-minio-from-source/contracts/image-contract.md` and
`specs/070-minio-non-root/contracts/runtime-identity.md` for every instance. Those documents stay as
history.

---

## S1 — Image

`rustfs/rustfs:<semver>@sha256:<index digest>` — the Alpine tag, never `-glibc` (research R3), never a
floating tag, never `latest`. The digest is the **index** digest from
`docker buildx imagetools inspect`, not a platform manifest digest. All instances pin the **same**
digest; Renovate moves them together.

**Verify**: `infra-image-scan.test.mjs`'s "(412) every third-party infra image reference is
digest-pinned" passes with RustFS in the enumerated set; the new visibility assertion (T023) names
each file.

## S2 — Runtime identity

The image's own user (uid **10001** for 1.0.1). **No `user:` key on any RustFS service.** The uid is
not written as a literal in any compose file or script; the migration tool reads it from the pinned
image at run time.

*Supersedes 070-I1 (the number 1000). Keeps 070-I3 (identity stated in one place: the image).*

**Why**: a fresh named volume inherits the image's `/data` (10001, 0750); any other uid fails at
startup — measured, research R5. CI's backup destination is a fresh volume every run.

**Verify**: a guard asserts no RustFS service declares `user:` (T010); the rehearsal starts RustFS on
a fresh volume and on a migrated one (T009).

## S3 — Credentials

`RUSTFS_ACCESS_KEY` and `RUSTFS_SECRET_KEY`, each `${VAR:?…}` or a non-secret literal for the
access key only. Never the `MINIO_ROOT_*` aliases. Never unset (the image would fall back to the
well-known `rustfsadmin` with only a warning — research R4).

| Instance | Access key | Secret |
|---|---|---|
| `langfuse-rustfs` | `langfuse` (literal, non-secret) | `${LANGFUSE_RUSTFS_SECRET_KEY:?…}` |
| `mcm-bff-backup-rustfs` | `${BACKUP_TEST_S3_ACCESS_KEY:-mcmbackuptest}` | `${BACKUP_TEST_S3_SECRET_KEY:?…}` |
| Nx-cache store | `nxcache` (host `.env`) | host `.env`, mode 600 |

## S4 — Health

```yaml
healthcheck:
  test: ["CMD", "curl", "-fsS", "-o", "/dev/null", "http://localhost:9000/health/ready"]
  interval: 10s
  timeout: 5s
  retries: 10
  start_period: 20s
```

Every dependant that today waits on `langfuse-minio: condition: service_healthy` waits on
`langfuse-rustfs: condition: service_healthy`.

**Verify**: T011 measures that `/health/ready` is non-200 before the drive is initialised; if it is
not, this clause is amended to an authenticated `HEAD /<bucket>` before implementation proceeds.

## S5 — Bucket creation

A separate init service using the **same pinned RustFS image** (`entrypoint` overridden), credentials
in the **container environment** referenced as `$$VAR`, fed to `curl -K -` on stdin, never in argv:

```sh
printf 'user = "%s:%s"\n' "$$S3_ACCESS_KEY" "$$S3_SECRET_KEY" \
  | curl -fsS -K - --aws-sigv4 "aws:amz:us-east-1:s3" -o /dev/null -X PUT http://<service>:9000/<bucket>
```

- **dev / backups**: one-shot, exits 0; dependants use `service_completed_successfully`.
- **prod**: after success `touch /tmp/ready && exec sleep infinity`, `restart: always`, healthcheck
  `test -f /tmp/ready`; dependants use `service_healthy` (Komodo stack-health — an exited container
  counts as unhealthy).

Idempotent by measurement: PUT of an existing bucket returns 200.

## S6 — Logs

`RUSTFS_OBS_LOG_DIRECTORY: ""` — logs to stdout, visible to `docker logs`, CI failure dumps and
`json-file` rotation.

## S7 — Console and ports

Console disabled (variable confirmed in T011). No console port published anywhere.
`langfuse-rustfs`: no ports. `mcm-bff-backup-rustfs`: `127.0.0.1:9100:9000` only. Nx-cache store:
`9000:9000` only (consumed on loopback by `nx-cache-server`; the existing tailnet-only ufw posture is
unchanged).

## S8 — Restart policy and naming

Prod: `restart: always` (`check-prod-restart-policy.mjs`). Names per research R11, registered in
`check-resource-naming.mjs`.

## S9 — Data volume

`/data`. Prod volume is `external: true`, named `observability-langfuse-rustfs-data`, and is created
**only** by the migration tool's `copy --apply` — never by `docker volume create` or by compose — so a
deploy before the copy fails on a missing external volume instead of starting on an empty store.
