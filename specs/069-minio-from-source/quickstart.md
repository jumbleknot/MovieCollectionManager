# Quickstart: verifying MinIO built from source

The runnable validation path. Every step states what you should see, because several of the failures
this feature guards against **look like success**.

---

## Prerequisites

- Docker available (dev container or host).
- `infrastructure-as-code/docker/observability/.env` populated — `LANGFUSE_MINIO_ROOT_PASSWORD` at
  minimum. If absent, `gen-dev-env.mjs` writes it; a missing file here presents as a credential error,
  not as a missing capability.

---

## 1. Build the image

```bash
docker build -t mcm-minio:local infrastructure-as-code/docker/minio/
```

**Expect**: a successful build. The Go compile of MinIO is not fast — several minutes is normal, and
is why this is a separate weekly workflow rather than part of cd-deploy.

**If the source fetch fails**: that is the residual risk in `research.md` §R4/Residual — upstream may
have removed the source too. The failure is loud and the last published image remains in our registry.

---

## 2. Contract check — the image itself

```bash
docker run --rm --entrypoint sh mcm-minio:local -c 'minio --version && mc --version && id -u'
```

**Expect**, in order:

| Check | Expected | Contract |
|---|---|---|
| `minio --version` reports | `RELEASE.2025-09-07T16-13-09Z` | C3 |
| `mc --version` reports | `RELEASE.2025-08-13T08-35-41Z` | C3 |
| `id -u` reports | `0` | C5 |
| the command runs at all | `sh` exists | C2 |
| both binaries resolve | on `PATH` | C1 |

**The trap**: a version reporting `DEVELOPMENT` or empty means the `ldflags` stamp was lost. The
binaries still work, nothing fails at build time, and the defect surfaces much later. Read the version
strings; do not just check the exit code.

---

## 3. Bring the stack up

```bash
docker compose -f infrastructure-as-code/docker/observability/compose.yaml --profile observability up -d
docker compose -f infrastructure-as-code/docker/observability/compose.yaml ps
```

**Expect**: `langfuse-minio` reaches `healthy`, and `langfuse-minio-init` reaches
`exited (0)`.

**The trap**: `langfuse-minio` running but never `healthy` means `mc` is missing from the image — the
C1 failure. The server works fine; the health check cannot run. Everything downstream then waits on
`service_healthy` forever, which reads as "the stack is slow" rather than "the image is wrong".

---

## 4. Prove the bucket exists

```bash
docker compose -f infrastructure-as-code/docker/observability/compose.yaml \
  logs langfuse-minio-init
```

**Expect**: `langfuse bucket ready`.

---

## 5. Prove ingestion end to end — the real acceptance

Bucket creation alone is not proof; Langfuse must actually write an object.

```bash
docker compose -f infrastructure-as-code/docker/observability/compose.yaml \
  logs langfuse-worker langfuse-web | grep -iE "Failed to upload JSON to S3|S3|minio" | tail -20
```

Then record a trace through the agent path and re-check.

**Expect**: no `Failed to upload JSON to S3`. That exact string is the documented symptom of a missing
bucket (LangFuse v3 does not auto-create it), and it is why the init container exists at all.

**Expect also**: objects present under the `langfuse` bucket —

```bash
docker compose -f infrastructure-as-code/docker/observability/compose.yaml \
  exec langfuse-minio mc ls --recursive local/langfuse | head
```

---

## 6. Prove existing data survives

Run against a volume already written by the **current** image, not a fresh one.

```bash
docker compose -f infrastructure-as-code/docker/observability/compose.yaml \
  exec langfuse-minio mc ls --recursive local/langfuse | wc -l
```

**Expect**: the pre-existing object count, unchanged, and new writes succeeding.

**Why this is separate from step 5**: step 5 passes on an empty volume. Only this step tests the thing
that would break production — the on-disk format and the volume's ownership.

---

## 7. Verify volume ownership — the open question

The design *infers* the live volume is root-owned from the upstream image's published config. Confirm
it against the real thing **before** the production rollout.

```bash
docker run --rm -v langfuse-minio-data:/data alpine:3.24 stat -c '%u:%g %n' /data
```

**Expect**: `0:0 /data`.

**If it is not `0:0`**: stop. The plan's C5 assumption is wrong for this host, and the rollout needs an
ownership step that this change deliberately does not include.

---

## 8. Verify the scanner actually covers the image

```bash
node scripts/infra-image-scan.mjs --list | grep -i minio
```

**Expect**: the `jumbleknot/minio` reference is **listed**. If it is absent, the exclusion rule is
still excluding it and the image is published unexamined — the exact defect
`contracts/scanner-scope.md` exists to prevent.

```bash
node --test scripts/__tests__/infra-image-scan.test.mjs
```

**Expect**: all pass, including the new completeness and `jumbleknot`-not-in-`BUILT_IMAGE_NAMES`
assertions.

---

## 9. Verify the CI sweep was real, not skipped

After pushing, do **not** read the green tick alone.

```bash
API=…/api/v1/repos/jumbleknot/mcm
curl -sS -H "Authorization: token $MCM_FORGE_TOKEN" "$API/commits/<sha>/statuses?page=1&limit=100" \
  | jq -r '.[] | select(.context|test("infra-image-scan / infra-image-scan")) | "\(.context)  \(.description)"'
```

**Expect**: `Successful in 2m30s`–`3m`.

**A `Successful in 2s`–`14s` means Trivy never ran** and the green proves nothing. Read the job
duration from the status description, never computed from `/actions/runs` timestamps — those are
workflow-level and include queueing, which on a capacity-1 runner dwarfs the signal.

---

## Teardown

```bash
docker compose -f infrastructure-as-code/docker/observability/compose.yaml --profile observability down
```

Add `-v` **only** on a throwaway volume. On a host carrying real Langfuse data it destroys exactly what
step 6 exists to protect.
