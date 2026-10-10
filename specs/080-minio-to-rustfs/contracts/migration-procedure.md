# Contract: In-place migration of a MinIO drive to RustFS

Applies to: production Langfuse (`observability-langfuse-minio-data`), the dev Langfuse volume, and
the host-managed Nx-cache volume. **Not** to the backup test destination (fixture data, fresh volume).

Steps marked **[OPERATOR]** run on the production host or in Komodo and cannot be performed by CI or
by an agent. Each step names its tool command; the tool is `scripts/object-store-migration.mjs`
(research R12).

---

## M0 — Preconditions (before the window)

1. **[OPERATOR]** Komodo Variable `LANGFUSE_RUSTFS_SECRET_KEY` exists (fresh value by default).
   The old `LANGFUSE_MINIO_ROOT_PASSWORD` Variable is **not** touched.
2. The implementation PR is green on `guardrails`, `app-ci` and `infra-image-scan`, rebased on the
   Langfuse 4.56.0 change (item #642), and approved — but **not merged**.
3. The rehearsal (`rehearse`, T009) and the dev migration (T021) have passed, with output recorded.
4. **[OPERATOR]** `inventory` has been run once against prod in advance (read-only; MinIO may be
   running) as a go/no-go: layout `xl-single`, one drive, zero SSE, zero tiered. Any refusal stops the
   feature for an operator decision (see spec Edge Cases).

## M1 — Quiesce writers

**[OPERATOR]** `docker stop langfuse-web langfuse-worker`. MinIO keeps running.

## M2 — Manifest

**[OPERATOR]** `node scripts/object-store-migration.mjs manifest --endpoint http://langfuse-minio:9000
--out <dir>/manifest.json` (credentials from the environment, not argv). Lists every object and
SHA-256s every multipart object plus the deterministic sample.

## M3 — Stop the old store, inventory, copy

**[OPERATOR]**

```sh
docker stop langfuse-minio-init langfuse-minio
node scripts/object-store-migration.mjs inventory --volume observability-langfuse-minio-data --out <dir>/inventory.json
node scripts/object-store-migration.mjs copy --from observability-langfuse-minio-data \
     --to observability-langfuse-rustfs-data --image <pinned rustfs ref> --apply --out <dir>/copy.json
```

`copy` refuses if the target volume exists, mounts the source `:ro`, chowns the target to the uid read
from `<pinned rustfs ref>`, asserts zero entries with another owner, and re-digests the source
(must equal `inventory.json`'s digest).

## M4 — Deploy

**[OPERATOR]** Merge the PR. `app-ci` on `main` → `trigger-cd` → `cd-deploy` (`deploy=true`) → Komodo
redeploys `prod-observability` on the new compose. Langfuse ingestion is paused from M1 until this
completes (accepted; same as the feature-072 cutover).

If the deploy runs before M3 has created the external volume, compose fails on the missing volume —
the intended fail-safe (contract S9).

## M5 — Verify

**[OPERATOR]**

```sh
node scripts/object-store-migration.mjs verify --endpoint http://langfuse-rustfs:9000 \
     --manifest <dir>/manifest.json --out <dir>/parity.json
```

Pass = SC-001. Then in the Langfuse UI: a pre-migration trace with media loads; run one assistant
turn and its trace loads (SC-002). `docker ps` shows every `prod-observability` container healthy,
Komodo's stack health is green (SC-006); Grafana loads and infra telemetry is current (SC-008).

## M6 — Rollback (only if M5 or later checking fails)

**[OPERATOR]**

1. `git revert` the merge commit on `main` (restores the MinIO compose, `stacks.toml`'s
   `LANGFUSE_MINIO_ROOT_PASSWORD` and `REGISTRY_HOST` lines). Push via a PR as usual; `cd-deploy`
   redeploys.
2. Komodo redeploys MinIO on `observability-langfuse-minio-data` — untouched, still uid 1000 — with
   the original Variable.
3. Confirm with `manifest` against MinIO that the object count equals the pre-migration manifest.
4. Writes accepted by RustFS since M4 are lost (one-way format; accepted risk).
5. Leave `observability-langfuse-rustfs-data` in place for diagnosis; delete it only after a new
   attempt is planned.

## M7 — Deferred cleanup (after the rollback window, default 14 days)

**[OPERATOR]** `docker volume rm observability-langfuse-minio-data`; delete the Komodo Variable
`LANGFUSE_MINIO_ROOT_PASSWORD`; delete the `jumbleknot/minio` registry package. Then a follow-up PR
deletes the migration tool and its guard exemption (T048).

## M8 — Nx-cache store (host-managed)

Same M1–M5 with: writers = `systemctl --user stop nx-cache`; old volume = the host compose's
`minio_minio-data` (confirm the real name with ownership **and** contents — feature 070 trap 1); new
host compose at `/home/prod/rustfs/compose.yaml` from the runbook; verify = `manifest`/`verify` plus a
CI remote-cache hit (SC-010). Rollback = `docker compose up -d` in `/home/prod/minio/`. Rebuildable
data, so a failed verify may be resolved by recreating empty instead (spec Open Question 1).
