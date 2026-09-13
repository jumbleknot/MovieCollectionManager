# Phase 0 research — the Langfuse 4 gate

**Date**: 2026-09-13 · **Spec**: [spec.md](./spec.md) · **Tasks**: T001–T004 · **Backlog**: item #433

## T001 — the digests under test

```
langfuse/langfuse:4                  -> sha256:a5d8d2457702ab7e051bc0788d73871970caebd10aae6635e87cfb736e4067cd
langfuse/langfuse-worker:4           -> sha256:5e35e625a214dd868bb22adad90fc52e8f83cc856c3750e47f9a922622c207fb
clickhouse/clickhouse-server:25.12   -> sha256:8a790dd3468db22b1d4e7b18a176f378ff5ff6053b9c48dd4ea1fa71a24c5ba6
```

Resolved on **Docker Hub** per FR-006 — upstream's reference compose pulls `docker.langfuse.com`, which is a
preference rather than a requirement, and Docker Hub publishes the same tags (4.35.0 current).

ClickHouse is scanned alongside deliberately: the spec widens rather than splits, so 25.12 is part of this
change and a new blocking advisory there would block the feature just as surely as one in Langfuse.

## T002 — how they were scanned

```
trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed --scanners vuln
```

trivy **0.74.0**, the version pinned in `infra-image-scan.yml`.

> **INSTRUMENT — set BOTH mirrors.** `mirror.gcr.io` is unreachable from the dev container, and trivy exits
> **1** on a DB-download failure, which is indistinguishable from "findings were blocked" by exit code alone.
> A Java image additionally needs the **Java DB**, which `TRIVY_DB_REPOSITORY` does not cover — that bit the
> sibling feature 071 gate, where the first run "failed" having analysed no JARs at all. Use:
>
> ```
> TRIVY_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-db:2
> TRIVY_JAVA_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-java-db:1
> ```
>
> **A verdict is only readable from a run with zero `FATAL` lines.** All three runs below had zero.

## T003 — the measurement

| Image | exit | FATAL | Fixable CRITICAL |
|---|---|---|---|
| `langfuse/langfuse:4` | **0** | 0 | **none** |
| `langfuse/langfuse-worker:4` | **0** | 0 | **none** |
| `clickhouse/clickhouse-server:25.12` | **0** | 0 | **none** |

**CVE-2026-75604 / GHSA-2xp9-vwfh-vxw4 is ABSENT from all three.**

And it is absent because it is **fixed**, not because trivy failed to look: the bundled package is

```
next: 16.3.3
```

which is exactly the fixed version the current allowlist justification names ("fixed in 15.5.24 / 16.3.3").
That distinction matters — an advisory missing from a scan and an advisory remediated in the artifact look
identical in a summary table, and only the second one justifies deleting a suppression.

**No new blocking advisory is introduced** by either the Langfuse major or the ClickHouse major (US-1 #4's
other branch) — including by ClickHouse 25.12, which is the half of this change with no security argument of
its own and therefore the one that could only ever cost.

## T004 — VERDICT: **PROCEED**

Both branches of US-1 #2 are satisfied: the advisory is absent from both Langfuse images, and the ClickHouse
major that Langfuse 4 requires introduces nothing blocking.

Proceed to Phase 1 — the Postgres tripwire (T005/T006) — **before** any image moves, per the task order.

---

# Phase 1–2 partial verification — 2026-09-13

## What was verified, and how

The dev observability stack was **running on 3.x with 36 hours of data**, and its compose file pins both
container names *and* volume names, so `docker compose -p <other>` cannot isolate a second copy. Rather
than destroy a running stack to test an upgrade, a throwaway project was derived from the real compose
file — same image digests, same environment, renamed containers/volumes, network aliases mapping the
original hostnames, and no published ports.

**Result — the data tier of this upgrade is sound on fresh volumes:**

| Service | Version under test | Result |
|---|---|---|
| `clickhouse-server` | **25.12** (the major Langfuse 4 drags in) | **healthy** on an empty volume |
| `postgres` | **16-alpine** — unchanged, per FR-005 | **healthy** |
| `redis` | `7-alpine` — unchanged | **healthy** |

That ClickHouse 25.12 initialises cleanly from empty is the single most load-bearing assumption in this
spec ("Assumptions": *ClickHouse 25.12 accepts an empty data directory*), and it is now measured rather
than assumed. Postgres staying healthy on **16** is FR-005's premise holding.

## What was NOT verified, and why — READ BEFORE CUTOVER

**Langfuse 4's own migrations, the `LANGFUSE_INIT_*` re-seed (T009) and a real trace (T010) are UNVERIFIED
locally.**

The throwaway's MinIO would not start, so `langfuse-web` and `langfuse-worker` never came up. The cause is
an artifact of the throwaway, **not** of Langfuse 4:

```
Error: unable to create (/data/.minio.sys/tmp) file access denied
FATAL Unable to initialize backend: file access denied
```

That is the exact signature feature 070 / item #421 documented for a non-root MinIO against a root-owned
volume — except here the fresh volume **was** `chown`ed to `1000:1000`, matching the container's own user,
and the denial persisted. That points at uid mapping in the dev container's Docker sandbox rather than at
anything in this change. Chasing it further would have been a side quest into a *different* feature's
territory, on a disk with 3.8 GB free.

**The honest consequence:** T009 and T010 remain **open**, and the risks they cover are real —

- Langfuse 4 ships **database migrations**; nothing here has watched them run.
- The ten `LANGFUSE_INIT_*` keys re-seeding a fresh 4.x instance with **no operator UI step** is the
  property the whole migration's cheapness rests on, and it is still an assumption.
- Whether the gateway's existing credentials authenticate against 4.x is untested.

**Do not treat the prod cutover (T013) as low-risk on the strength of this document.** Run T008–T010
against the real dev stack first — which does mean recreating its volumes, and is exactly what ADR-0002 §4
ratifies as acceptable for dev.
