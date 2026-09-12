# Implementation Plan: MinIO runs as a non-root, explicitly-numbered uid

**Spec**: [spec.md](spec.md) · **Contract**: [contracts/runtime-identity.md](contracts/runtime-identity.md)
· **Branch**: `421-minio-non-root` · **Created**: 2026-09-12

## Approach

Change **identity only**. Feature 069 held every variable but packaging constant so that a failure was
attributable; this holds every variable but identity constant for the same reason. The base image, the
build stages, the pinned MinIO/mc versions, the entrypoint and the absence of a `CMD` are all untouched.

Four edits, one operator action, and one contract renegotiation:

| # | Change | File |
| --- | --- | --- |
| 1 | Create `minio` at uid/gid **1000** with a home directory; set `HOME`; add `USER 1000:1000` | `infrastructure-as-code/docker/minio/Dockerfile` |
| 2 | Renegotiate clause **C5** in place | `specs/069-minio-from-source/contracts/image-contract.md` |
| 3 | Flip the CI assertion from `id -u == 0` to the contracted uid, at the cause | `.forgejo/workflows/minio-image.yml` |
| 4 | Document the one-time volume migration for dev and prod | `docs/runbooks/prod-control-tower.md` |
| — | Run the migration on the production host | **operator, outside CI** |

## Why the `HOME` change is part of this and not a follow-up

It is not a nicety. `mc` runs in the healthcheck that `langfuse-web` and `langfuse-worker` gate their
startup on, and in the one-shot that creates the `langfuse` bucket. Without a writable `HOME` both fail,
the stack does not come up, and the symptom ("minio unhealthy") does not name the cause. Splitting it out
would ship a change that is known-broken. Measured evidence is in the spec and in contract clause I2.

## Sequencing, which is the part that matters

**The obvious framing is wrong, and measurement corrected it.** Merging does *not* arm a broken deploy:
both compose files pin the image by digest (contract C6), so nothing consumes the newly-published image
until those pins are updated in a separate commit. And the chown is *non-disruptive* — root bypasses DAC
checks, so the currently-running root image keeps working on a `1000:1000` volume (measured: clean
restart, `mc ready local` ready, new write OK, zero storage errors).

```
  [OPERATOR: chown prod volume]  ──▶  merge  ──▶  minio-image publishes a NEW digest
   non-disruptive; the running          nothing          │
   root image is unaffected             deploys          ▼
                                               update compose digest pins  ──▶  deploy
                                               ▲
                                     THE REAL GATE — this step, not the merge,
                                     is what must not precede the chown
```

CI's `minio-image` job builds and asserts the contract on the PR, so the image is proven before the
operator step. The operator step is proven by the `find /data ! -user 1000 | wc -l` check in I4, not by
a `stat` of `/data` — see the second trap recorded there.

## Testing strategy

There is no unit-test surface here; the assertions are container-level and live in two places:

1. **The CI contract check** (`minio-image.yml`) — runs on every build, before publish. It is the
   durable guard: it already caught the C3 version-stamp loss, and flipping C5 rather than deleting it
   keeps the identity under the same protection.
2. **A local end-to-end run against a volume with pre-existing objects** — the thing a fresh volume
   cannot prove. Already executed for this plan; see tasks T001–T004 for what was measured.

The web/agent E2E tiers are untouched: this feature changes no application surface.

## Risks

| Risk | Mitigation |
| --- | --- |
| Merge lands before the prod chown | Stated as a hard gate in the spec, the PR body, and this plan. The PR is opened as a draft-equivalent and the operator step is the merge condition. |
| The chown looks done but is not | I4's verification counts entries not owned by the target uid, rather than stat-ing the top level — the exact failure observed during this work. |
| A root-owned process touches the volume after the chown | Recorded as trap 2 in I4. The migration is the last thing before the non-root container starts. |
| uid drift on a future rebuild | FR-002: explicit integers, asserted in CI. |
| Dev and prod diverge | Both volumes are migrated, separately and explicitly (T005/T006). |
