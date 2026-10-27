# CLI contracts: Silent-failure visibility (feature 084)

Every tool here runs from a script that rejects an argument it does not recognise (exit 2 with a
usage line). Report-only is always the default; an action happens only when a flag explicitly asks.
CLAUDE.md records why: an unrecognised `--dry-run` once meant "delete for real".

## `infrastructure-as-code/backup/backup.sh` (prod host, prod user)

| Invocation | Effect | Exit |
|---|---|---|
| *(no args)*, from `homelab-backup.service` | Runs the dumps, checks them, uploads with restic, applies retention, writes the manifest, and alerts on failure or shrink | 0 when every dump is ok, or only shrink/oversize alerts were raised; 1 on any `failed-*` or restic failure, which fires `OnFailure` |
| `--ack-shrink <name>` | Writes `state/ack-shrink-<name>` and exits | 0; 2 if the name is not a known dump |
| `--check-staging` | Prints the staging directory and its filesystem type; refuses tmpfs | 0 or 1 |
| anything else | usage | 2 |

The script needs these environment variables, as today. It never echoes a value, only length checks:
`RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE`, and the compose env files it reads live.

## `backup-alert.sh <reason> <detail-file-or->`

- **Reasons**: `failed`, `hung`, `stale`, `staleness-unreadable`, `shrink`, `komodo-oversize`,
  `recovered`. Any other reason exits 2.
- **`failed <unit>`** is what the `OnFailure` unit sends. The script reads
  `systemctl --user show -p Result <unit>`, and reports `hung` when the result is `timeout` (the 2 h
  `TimeoutStartSec`), otherwise `failed`.
- **Token**: read from `~/backup/forge-issue-token`. If that file is missing or not mode 600, the
  script exits 3 and logs `alert NOT delivered: token file …`. The journal still holds the failure,
  and the staleness check is the second path.
- **HTTP**: a non-2xx response exits 4 and logs the status code. The body is printed only after
  passing through the redaction filter (URI user-info masked; credential-bearing lines dropped).
- **`recovered`** with no open item does nothing and exits 0.

## `backup-staleness.sh`

| Condition | Action | Exit |
|---|---|---|
| Newest `homelab` snapshot is 36 h old or less | prints its age | 0 |
| Over 36 h | `backup-alert.sh stale` | 1 |
| restic error, no snapshot, or an unparsable time | `backup-alert.sh staleness-unreadable` | 1 |

`MCM_BACKUP_STALE_HOURS` exists **for tests only**. The units do not set it, and a guard asserts that.

## `scripts/ci-status.mjs` (changed behaviour only)

- `status --sha <main-sha>`: adds an advisory row, `cd-deploy / build-deploy (dispatched)  <state>
  run <id>`. The verdict line and exit code are computed exactly as before (FR-012).
- `watch --sha <main-sha>`: returns once the required contexts are terminal **and** the dispatched
  deploy is not `waiting`. A failed deploy is printed as `DEPLOY FAILED (advisory)`. The exit code
  for a merge verdict is unchanged; a failed deploy adds exit code **4**. Code 3 already means "still
  waiting / no verdict yet" (`exitCodeForVerdict`), and 4 is unused, so a caller can tell "deploy
  failed" from "keep waiting".
- `failure --sha <sha>` / `--run <id>`: when no failed status exists but a failed dispatched run
  does, it prints `ci-failures/<run_id>`'s digest. When that bundle is missing it prints
  `deploy run <id> FAILED; no evidence bundle published` and exits 1.

## `scripts/cd/scan-app-image.sh <local-tag>`

| Exit | Meaning |
|---|---|
| 0 | scanned, and no un-allowlisted fixable Critical |
| 10 | **scanner error**: nothing was assessed |
| 11 | **blocking finding**: the table names the image and the CVE |

`scan-push.sh` and the `app-image-scan` job both map 10 and 11 to their existing two messages.

## `scripts/registry-retention.mjs`

| Invocation | Effect |
|---|---|
| *(no args)* | Report: one line per version (`package  version  created  decision  reason`), then totals per package and the bytes that would be freed |
| `--apply` | Deletes the `delete` rows, **only if** the config says `mode: apply`; otherwise it exits 2 naming the mismatch |
| `--package <name>` | Limits the run to one package; usable with either mode |
| `--json` | The report as JSON, for the workflow summary and the tests |

Before any delete it runs the **protected-set preflight**: it resolves every protected digest to a
registry version, and if any digest cannot be resolved it exits 5 without deleting anything.
