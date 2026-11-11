---
type: Decision
title: "ADR-0004: Wiki summaries are maintained by the coding session"
description: The ratified decision (feature 098, 2026-11-10) that a derived openwiki page is refreshed by the coding session that changes its source, in the same PR, with a source fingerprint and the blocking V17 check in place of Claims and a scheduled generator — the measured cost progression that led there, what was retired, the list-valued writer policy, and when to revisit.
resource: docs/decisions/ADR-0004-session-maintained-wiki.md
resource-sha256: 85d0acaa8dd1625432587bf102e0b8ae506244a8878d67bed3b17ace27ba4141
tags: [adr, openwiki, okf, decision-record, documentation, ci]
timestamp: 2026-11-10T03:22:23.672Z
---

# ADR-0004: Wiki summaries are maintained by the coding session

Accepted 2026-11-10 (feature 098). **A derived `openwiki/` summary is refreshed by the coding session
that changes its source, in the same PR, and CI blocks a PR whose summary is stale.** It supersedes the
Claims half of [ADR-0003](./adr-0003-claims-and-fingerprints.md); ADR-0003's fingerprint half —
`protected.yaml` guarding authoritative pages — stands. The full record is
[`docs/decisions/ADR-0004-session-maintained-wiki.md`](../../docs/decisions/ADR-0004-session-maintained-wiki.md);
how to operate it is the [bundle maintenance runbook](../runbooks/wiki-maintenance.md).

## The mechanism

- **Fingerprint.** Each derived page records `resource-sha256`, the SHA-256 of its single `resource`
  file after CRLF→LF normalisation. Nothing else is fingerprinted.
- **Check.** Rule **V17** in the required `okf` check fails a derived page whose fingerprint is missing,
  malformed or different from its source's, whose source no longer exists, or that still carries the
  retired `sources:`/`verified:` fields.
- **Tool.** `scripts/wiki-refresh.mjs` lists stale pages, shows the source's change since the last
  record, and records the new fingerprint — offline and free. The `wiki-refresh` skill teaches it.
- **Generator.** openwiki stays only as a manual, dispatch-only rebuild of operator-named pages.

## Why the session, and why now

Each step from feature 043 onward was a measured answer to the one before: hand generation, then
merge-triggered maintenance (044), a cheaper provider (078), a job deadline, low-effort retries, kept
verified pages and a Claims audit (#707), drift re-planning (082), a 4-page invocation cap, and finally
a daily schedule with cooldowns (078 US7). The last month measured **$167.80 over 106 runs for 39
distinct pages**, and run 5104 paid about $1.44 for one landed page while 30 Claims-forced pages starved
the 4 requested ones. The session that edits a source has already read it and runs on the subscription,
so freshness costs nothing extra, and V17 checks it in the PR that made the summary stale — drift can no
longer accumulate on `main`. The granularity is honest too: one page, one file, one hash, where
openwiki's Claim-level staleness flagged about 30 pages on any day and the page-level test found 12.
The accepted risk is a fingerprint recorded without reading the diff; the skill makes `--diff` step one,
and a fingerprint-only change is visible in review.

## What was retired

The Claims sidecars, `.page-manifest.json`, `.last-update.json` and the run record (all deleted and
gitignored); the `sources:`/`verified:` fields; checks V16, V12 and G13; and the unattended machinery —
range planning and the marker, the backlog, escalation, cooldowns, drift re-planning, the quiet-trigger
and the Claims audit. Two pages whose `resource` was a directory became canonical:
[spec-driven development](../process/spec-driven-development.md) and the
[mc-service data model](../architecture/data-model.md).

## The writer policy

`openwiki/policy.yaml`'s `actor` may be a list, and `openwiki/**` is `[agent, generator]`: sessions
write routinely and the generator writes on a manual rebuild. G3 still confines `generator` to
`openwiki/`. **G14** fails a derived page whose `resource` is a directory or a file Renovate or CD
rewrites, so no bot change can make a page stale with no session there to refresh it.

## When to revisit

When the four-week scoring follow-up shows refreshes routinely fingerprint-only where the diff changed
what the page says; when an unattended generator becomes cheap and reliable enough that its cost does not
matter; when a derived page's only honest source is something a bot rewrites; or when mc-service's domain
layer becomes active again, at which point the data-model page is re-pointed at one file.
