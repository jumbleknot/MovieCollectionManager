# Spec 100: The wiki generator's telemetry opt-out is checked, and three claims the wiki repeated are made true

**Status**: Complete | **Date**: 2026-11-12 | **Input**: backlog items #516 and #604

## Problem

**Item #516.** The `wiki-update` target sets `OPENWIKI_TELEMETRY_DISABLED=1` because openwiki reports
each run to a third-party analytics host by default (FR-030). Nothing had ever checked that the
opt-out works. openwiki 0.5+ can write what a run did with telemetry to `--telemetry-file`, but no run
used it.

**Item #604.** Three places in the code said something the code did not do, and the wiki summaries
repeated each one:

1. The three MCP server images, and the agent gateway's, were commented "read-only .venv + source at
   runtime". But they copied `/app` with `--chown=app:app`, so the runtime user owned it and could
   write to it.
2. mc-service's router said `filter-options` and `count` "must appear BEFORE /{movieId} to avoid route
   shadowing". Under axum 0.8 that was never checked.
3. The BFF falls back to `http://127.0.0.1:8123` when `AGENT_GATEWAY_URL` is unset. The canonical
   agent-layer runbook did not say so, and the wiki called the variable "the BFF's only pointer".

## Requirements

- **FR-001**: Measure the opt-out at $0, with each variable alone and with both. Record the result in
  `docs/runbooks/wiki-maintenance.md`.
- **FR-002**: Record what a run would send without the opt-out by reading the source, never by sending
  it.
- **FR-003**: The launcher MUST force both opt-out variables, pass `--telemetry-file` on every run, and
  exit 3 on any record other than `{disabled: true, sent: false}`. A run with no record is not judged.
- **FR-004**: `wiki-maintain` MUST give each invocation its own record path. On a bad record it MUST
  stop the rebuild without retrying and exit 1.
- **FR-005**: In all four Python images, `/app` MUST be root-owned, so the `app` user cannot write it.
  A guard test MUST fail any Python image that gives `/app` to its runtime user.
- **FR-006**: A unit test MUST register the movie routes in reverse order. The router comment MUST state
  what that test shows.
- **FR-007**: The fallback MUST be documented in `docs/runbooks/agent-layer.md`.
- **FR-008**: The affected wiki pages MUST be refreshed in this PR.

## Success criteria

- **SC-001**: All three opt-out probes write `{"disabled": true, "sent": false}`.
- **SC-002**: The new launcher, orchestrator and guard tests fail against the old code and pass against
  the new.
- **SC-003**: In each built image, `touch /app/...` as `app` is refused. The MCP servers' entry modules
  import, and the gateway answers `/health` with 200.
- **SC-004**: `wiki-refresh --stale` prints nothing, and `okf-lint` and `okf-governance` pass.

## Out of scope

- A compose-level `read_only: true` root filesystem. The root-owned `/app` gives the property the
  comment claimed. A read-only root filesystem is a separate hardening decision with its own `/tmp`
  questions.
