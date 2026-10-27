# Data model: Silent-failure visibility (feature 084)

There is no application data here. These are the records each tool writes or reads, with the rules
the tests pin.

## Dump manifest (`dump-manifest.tsv`): one per backup run, uploaded inside the snapshot

| Field | Type | Rule |
|---|---|---|
| `name` | string | After PR B: `forge-db`, `forge-data`, `komodo`, `mc-service-mongo`, `keycloak`, `bff-mongo`, `agent-db`, `release-apks`. In PR A only, the forge is still one `forgejo dump` named `forge` (format `tar.gz`), which PR B replaces with `forge-db` + `forge-data` |
| `file` | path | Relative to the staging dir |
| `bytes` | int | `stat -c %s` after the dump |
| `min_bytes` | int | Per-dump constant in the script; agent-db = 1 |
| `max_bytes` | int or `-` | Komodo only (500 MB) — FR-019d regression guard |
| `format` | enum | `pg-plain`, `pg-custom`, `gzip`, `tar`, `tar.gz` (PR A's `forge` only) |
| `prev_bytes` | int or `-` | From `state/last-good.tsv`; `-` when absent |
| `verdict` | enum | `ok`, `failed-command`, `failed-format`, `failed-min`, `warn-max`, `alert-shrink`, `ack-shrink` |

- A `failed-*` verdict ⇔ a `DUMP-FAILED-<name>` marker file exists in the staging dir.
- `alert-shrink` when `bytes < 0.5 × prev_bytes` and no `state/ack-shrink-<name>` exists; with the ack
  file the verdict is `ack-shrink` and the file is deleted after the run.
- Run outcome = **failed** if any verdict is `failed-*` or restic `backup`/`forget` exits non-zero;
  **alert** (not a unit failure) for `alert-shrink`/`warn-max`; else **ok**. Both failed and alert
  raise the backlog item; only **ok** writes `state/last-good.tsv`.

## Backup alert item (forge issue)

| Field | Value |
|---|---|
| title | `Prod backup: failed or stale` — the dedupe key (exact match) |
| labels | `type/bug`, `priority/p1` |
| body (on create) | reason, host, time (UTC), runbook link, the first event's detail |
| comment (each later event) | `reason` ∈ `failed`, `hung`, `stale`, `staleness-unreadable`, `shrink`, `komodo-oversize`, `recovered`; plus detail (journal tail ≤ 40 lines with secrets never present — the script logs no secret; the alert additionally masks URI user-info and drops credential-bearing lines) |

State transitions: none open → **created**; open → **commented**; `recovered` only comments, never
closes. Two events in one night (failure, then staleness 6 h later) comment twice on the same item.

## Dispatched deploy context (ci-status, in memory)

| Field | Source |
|---|---|
| `context` | constant `cd-deploy / build-deploy (dispatched)` |
| `run_id` | the newest matching run's `id` (not `run_number`) |
| `state` | `classifyCheckState` mapping of run `status`/`conclusion` → `passed`, `failed`, `waiting` |
| `required` | always `false` (no glob matches it) |
| `bundle` | `ci-failures` version `<run_id>` or `null` |

Selection: `workflow_id == 'cd-deploy.yml'` ∧ `event == 'workflow_dispatch'` ∧ `head_sha == sha`;
newest by `id`. None → no context added (and `status` prints `no deploy dispatched for this sha`
only for a `main` sha).

## Retention config (`infrastructure-as-code/forgejo/registry-retention.yaml`)

```yaml
mode: report            # report | apply — apply also requires --apply on the command line
evidenceWindowDays: 45  # >= the ci-status duration sample (guard-tested)
packages:
  - name: mc-service    # repeated for the six app images
    type: container
    keepNewest: 40
    keepDays: 30
    protect: deployed-and-rollback   # from .env.deploy at main and 5 prior promotions
  - name: mcm-devcontainer
    type: container
    keepNewest: 4
    keepDays: 21
    protect: devcontainer-pin
  - name: ci-failures
    type: generic
    keepNewest: 400     # floor: DEFAULT_DURATION_RUNS × bundle-publishing jobs (T060/T064)
    keepDays: 45
  - name: mcm-app-android
    type: generic
    keepAll: true
```

Validation (script refuses to start on any): unknown key; `mode` not in the enum; a package without
`keepAll` lacking both `keepNewest` and `keepDays`; `keepDays` for `ci-failures` <
`evidenceWindowDays`.

Per version, the decision is `keep:newest`, `keep:age`, `keep:protected`, `keep:unconfigured`, or
`delete` — `delete` only when **none** of the keep reasons hold.
