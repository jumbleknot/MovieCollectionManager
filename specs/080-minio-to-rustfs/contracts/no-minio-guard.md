# Contract: the no-MinIO guard

`scripts/__tests__/no-minio-references.guard.test.mjs`, run by `guardrails` (node `--test` glob).

## G1 — What it scans

Every git-tracked file (`git ls-files`), matched case-insensitively against `/minio/`.

## G2 — Exemptions (closed list, each with its reason)

| Exemption | Kind | Reason |
|---|---|---|
| `specs/**` | path | Completed specifications are history; 069/070 describe what was built. |
| `docs/decisions/**` | path | ADRs record the decision as made (ADR-0002 names MinIO in Langfuse's dependency set at the time). |
| `docs/proposals/**` | path | Pre-specification history, already excluded from Renovate and the wiki. |
| `openwiki/**` | path | Generated; regenerated from sources this guard covers. Derived pages summarising specs 069/070 legitimately name MinIO. |
| `pnpm-lock.yaml` | path | Third-party package names, not ours to rename. |
| `scripts/__tests__/no-minio-references.guard.test.mjs` | path | The guard holds the pattern. |
| `scripts/object-store-migration.mjs`, `scripts/__tests__/object-store-migration*.mjs` | path, **temporary** | Must name `.minio.sys`, MinIO's SSE marker and, for the rehearsal, the deployed MinIO image. Removed with the tool in T048. |
| `scripts/secret-scan.mjs` — the line carrying `\bminiosecret\b` | path + line regex | A scanner's detection set must not shrink as a side effect of a rename: old dev `.env` files and stashes can still hold that literal. |
| `scripts/__tests__/ci-digest-redact.test.mjs`, `scripts/__tests__/ci-failure-digest.test.mjs` — the `'minio' + 'secret'` plant | path + line regex | They prove the redaction of the pattern above. |
| `scripts/check-resource-naming.mjs` — the `RETIRED_KEYS` entries `langfuse-minio`, `langfuse-minio-init`, `mcm-bff-backup-minio`, `mcm-bff-backup-minio-init` | path + line regex | Rule 4 of the naming gate: a retired service key resurrected as an alias must fail loudly. Naming the dead keys is the mechanism. |
| `docs/runbooks/**` lines between `<!-- history:begin -->` and `<!-- history:end -->` | block marker | A runbook case study (e.g. renovate.md's "extraction is not grouping" lesson from item #560) keeps its evidence; the marker makes "this is history" a reviewable claim instead of an excuse. |

Anything else is a failure naming `path:line`.

## G3 — Instrument checks (the guard must prove it read something)

- It asserts it scanned more than N files (N = the tracked-file count at implementation, rounded
  down) — a guard that passes by listing nothing is the failure mode CLAUDE.md warns about.
- It asserts each path exemption matches at least one existing file, and each line-regex exemption
  matches at least one line — an exemption that matches nothing is stale and fails (the same rule the
  allowlist gate applies to unmatched entries).
- Mutation test (T033): plant `minio` in `README.md` → the guard fails naming `README.md:<line>`;
  remove it → green. Plant it inside a runbook history block → green; outside → red.
