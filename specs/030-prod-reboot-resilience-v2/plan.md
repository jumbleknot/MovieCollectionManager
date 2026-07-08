# Feature 030 — Plan

## Approach

"Both" (per operator decision, 2026-07-08): declarative `restart: always` for a guaranteed boot-restart **and** a corrected drain for clean shutdown — plus the RC#1 persistent periphery root. `always` is the version-robust guarantee (proven immune to the shutdown-timing problem on Docker 29.6.0); the drain is demoted to "graceful DB stop only."

## Tasks

### T1 — Recovery (done 2026-07-08)
- [x] Start `komodo-periphery-1` (Core reconnects) and `forgejo-forgejo-1` (git source).
- [x] Move `PERIPHERY_ROOT_DIRECTORY` → `/home/prod/komodo/periphery-root` in `compose.env` + `.env` (backups `*.bak-20260708`); `up -d` the komodo stack.
- [x] Komodo Execute Sync → checkout cloned to persistent disk; app tier + 127-containers recreated `Up`.
- [x] Verify auth/mcm 200 (internal + public).

### T2 — Committed restart policy (this branch)
- [x] `unless-stopped` → `always` in all 7 `*/compose.prod.yaml` (27 services; init containers `sleep infinity`, safe).
- [ ] PR → forge → guardrails/app-ci → merge → Komodo sync (recreates every stack from the persistent root with `always`).

### T3 — Committed docs
- [x] Correct `docs/runbooks/prod-reboot-resilience.md` §2c false claim; add Part 5 (RC#1, RC#2, drain rework, recovery ordering, revised validation checklist).
- [x] `Server-Setup-Runbook.md` Phase 9: set `PERIPHERY_ROOT_DIRECTORY` to a persistent path at bootstrap.
- [x] This spec + plan.

### T4 — Host state (applied on prod; documented in the runbook)
- [x] Interim: `docker update --restart always $(docker ps -q)`.
- [ ] Host-managed composes → `restart: always`: `/home/prod/{forgejo,cloudflared,beszel,dozzle,minio,uptime-kuma}/compose.yaml` + `/home/prod/komodo/ferretdb.compose.yaml`; `up -d` each.
- [ ] Rework `~/.config/systemd/user/docker-drain.service` ExecStop → parallel `xargs -P 20 docker stop -t 20`.

### T5 — Acceptance
- [ ] Unattended validation reboot; all rows of the Part-5 checklist pass on the first boot with zero intervention.

## Risk / rollback
- `always` on a genuinely-crashing container = crash-loop, but RC#1 removes the only crash trigger (missing checkout); a broken image would crash-loop under `unless-stopped` too.
- Rollback: revert the branch + host `.bak-20260708` restores (see runbook Rollback).
- The interim `docker update` is undone by any container recreate; the committed compose `always` + host-compose edits are the durable form.
