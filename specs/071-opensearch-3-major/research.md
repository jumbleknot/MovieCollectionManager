# Phase 0 research — the OpenSearch 3 gate

**Date**: 2026-09-13 · **Spec**: [spec.md](./spec.md) · **Tasks**: T001–T004 · **Backlog**: item #439

## T001 — the digest under test

```
opensearchproject/opensearch:3
  -> sha256:bcc1797519726ceb6d651d4a3e60b7c30da91793914a8dfe75fd441d4f641509
  (3.8.0; tag last pushed 2026-08-04)
```

Recorded as a **digest** per FR-001: a result against the floating `:3` cannot be re-checked once the tag
moves.

## T002 — how it was scanned

Gate criteria, verbatim (`scripts/cd/scan-push.sh` / `check-infra-image-findings.mjs`):

```
trivy image --exit-code 1 --severity CRITICAL --ignore-unfixed --scanners vuln
```

trivy **0.74.0** — the version pinned in `infra-image-scan.yml`, so this is comparable with CI.

> **INSTRUMENT — two DB mirrors are required here, not one.** `mirror.gcr.io` is unreachable from the dev
> container. Setting only `TRIVY_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-db:2` is **not enough for a Java
> image**: the first attempt still exited **1**, on `Unable to initialize the Java DB … failed to download
> artifact from mirror.gcr.io/aquasec/trivy-java-db:1`. Exit 1 is identical to "findings were blocked", and
> without the Java DB trivy cannot analyse JARs **at all** — so the run that "failed the gate" had in fact
> looked at none of the packages this decision is about. Both are needed:
>
> ```
> TRIVY_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-db:2
> TRIVY_JAVA_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-java-db:1
> ```
>
> The successful run is the one with **zero** `FATAL` lines. Check that before reading any verdict.

Run locally rather than in CI under FR-002's second branch — a Linux host with trivy and disk headroom
(measured 8.0 GB free against a 1.14 GB compressed image, scanned one at a time).

## T003 — the measurement

**Result: `Total: 6 (CRITICAL: 6)`, and all six are ONE advisory.**

| Advisory | On `opensearch:2` (what we run) | On `opensearch:3` | Outcome |
|---|---|---|---|
| **CVE-2025-14813** — `org.bouncycastle:bcprov-jdk15to18` 1.79 | present; **seed-baseline suppression since feature 035** | **ABSENT** | **DISCHARGED** |
| **CVE-2026-75595** — `io.netty:netty-handler` | present, 6 findings | present, 6 findings | **NOT discharged** |

**No new blocking advisory is introduced by 3.x** (US-1 #4's other branch): every one of the six findings is
CVE-2026-75595.

### The jar evidence

The bcprov discharge is structural, not a version bump — OpenSearch 3 replaced the old provider with the
**FIPS** distribution:

```
bc-fips-2.1.3.jar   bcpg-fips-2.1.11.jar   bcpkix-fips-2.1.9.jar
bctls-fips-2.1.20.jar   bcutil-fips-2.1.4.jar
```

`bcprov-jdk15to18-1.79.jar` — the jar whose mere presence kept the finding alive on 2.19.6 — **is gone.**

Netty is present twice, both below the fix:

```
netty-handler-4.2.16.Final.jar        (lib)      fix = 4.2.17.Final
netty-handler 4.1.133.Final           (bundled inside security-analytics-commons-1.0.0.jar)
                                                 fix = 4.1.137.Final
```

## T004 — VERDICT: exactly one of two, which US-1 #4 says gets no automatic answer

Per `spec.md` US-1 #4: *"the outcome is recorded on this spec as an explicit judgement with its reasoning —
there is no automatic verdict, because a major that halves a permanent suppression may or may not be worth a
data loss."*

**What the upgrade buys:** the removal of the only **permanent** suppression in the allowlist —
CVE-2025-14813 has been carried since the gate was built and, uniquely among the entries, had nowhere to go.
Discharging it is the entire strategic argument of ADR-0002 §2.

**What it does not buy:** CVE-2026-75595 is unaffected. It is present on 2.x and 3.x in equal measure (6
findings each), so on that advisory the two versions are a **wash** — remediation is an upstream rebuild
either way, and it stays time-boxed to 2026-10-01 regardless of which major we run.

**What it costs:** ADR-0002 §4 ratified that the production audit store is not preserved — so cutover
discards the production agent-audit history and restarts the 90-day retention window, on an append-only
*security* trail.

**Open question that changes the arithmetic** — see "Decision required" below.

## Decision required (not taken here)

The ratification in ADR-0002 §4 was made when the expectation was **two** advisories discharged. One of the
two did not materialise, so the benefit is halved while the cost is unchanged. That is precisely the
asymmetry US-1 #4 refuses to resolve automatically.

There is a third option the original decision did not consider, because it was not needed when the data was
assumed disposable: **preserve the audit indices.** OpenSearch 3 is Lucene 10 and reads indices *created* by
2.x (Lucene 9) under the usual N-1 rule, so a volume-preserving upgrade may be available at little extra
cost. If it is, the cost side of this trade falls to roughly zero and the judgement becomes easy.

**That property is NOT verified and must not be assumed** — it is exactly the shape of claim this spec's
own US-1 exists to stop. Verifying it means starting 2.x on a seeded volume, stopping it, starting 3.x on
the same volume, and reading the index back.

Until this is decided, **no compose file, renovate rule or allowlist entry moves** (FR-003).

---

# Can the audit data be preserved? — researched 2026-09-13

The T004 verdict left one question open: OpenSearch 3 is Lucene 10, so *maybe* it reads 2.x (Lucene 9)
indices in place, which would drop the cost of this upgrade to roughly zero. **Upstream does not support
that path for this deployment.**

From OpenSearch 3.0.0's release notes, **Breaking Changes**:

> Upgrade to Lucene 10.1.0 — PR #16366

From the upstream migrate-or-upgrade guide, the only two documented paths:

| Method | Applicable here? |
|---|---|
| **Rolling upgrade** — "Supports only adjacent major versions" (2→3 qualifies), but "**Reindexing may be required**" | **No.** The audit sink is `discovery.type=single-node`. You cannot roll one node. |
| **Snapshot and restore** — "Requires downtime… Requires provisioning a new cluster… Manual reindexing may be required" | Possible, but needs a snapshot **repository** the audit stack does not have, plus a restore, plus possible reindexing. |

**Nowhere does upstream state that a 3.x node will open a 2.x data directory in place.** That is precisely
what a volume-preserving upgrade would need, and it is not a documented path — so "keep the volume and
start 3.x on it" is an unsupported guess, not a cheap option.

Consequence: preserving the audit history is a **feature in its own right** (configure a snapshot
repository → snapshot → restore → verify → possibly reindex), not a task inside this one. The cheap options
remain the two ADR-0002 already named: recreate the volume and lose the history, or stay on 2.x.

This does not decide T004 — it removes the third option that looked like it might make the decision easy.

---

# The audit store is NOT empty — 5,276 documents (measured 2026-09-13)

A near-miss worth recording in full, because the wrong answer was about to justify destroying data.

`_cat/indices/mcm-agent-audit-*` returned **only a header row**, which reads as "the store is empty, so
discarding it costs nothing". It was a **pattern error**: `mcm-agent-audit-*` requires a trailing dash, and
the real index is **`mcm-agent-audit`** — no date suffix. Listing *every* index found it immediately:

```
index                docs.count  store.size
mcm-agent-audit            5276     326.9kb
security-auditlog-*          50     ~380kb    (OpenSearch security plugin's own audit log)
top_queries-*                87     ~330kb    (query-insights plugin)
```

**A zero from a filtered query means "no match", which is not the same as "no data".** The same shape as
item #418 (reading `event` instead of `trigger_event`) and the Langfuse sparse-fieldset trap in feature 072
(`total_cost: null` because the field was not requested). Third time this session; the cure each time was
to widen the query and look at everything rather than trust a filter.

## Consequences

1. **ADR-0002 §4's ratification deserves re-examination for the OpenSearch half.** "Neither production
   dataset is preserved" was ratified before anyone knew what the audit store contained. It contains 5,276
   security-audit events. That is not nothing, and the benefit on the other side of the trade has since
   halved (only bcprov is discharged; netty is not).

2. **Snapshot/restore is far more tractable than assumed.** The earlier assessment — "preserving is a
   feature in its own right" — assumed an unknown, possibly large dataset. At **326.9 kb / 5,276 docs** the
   restore is verifiable by exact document count, and "manual reindexing may be required for full feature
   compatibility" is a low risk for an append-only index with simple mappings. The work is configuring a
   snapshot repository (`path.repo` + a mounted volume + a restart), not moving data at scale.

3. **FR-006 names a pattern that does not match the real index.** The spec requires the write-only
   `agent-audit` account to retain index/bulk on `mcm-agent-audit-*`, and the compose header says the same.
   The live index is `mcm-agent-audit`. Either the role pattern differs from the prose or the prose is
   wrong — but a verification written against `mcm-agent-audit-*` would test a pattern that matches nothing
   and pass vacuously. **Resolve before implementing US-2.**

---

# T005–T007 — the FR-006 pattern bug, resolved from the repo (2026-09-13)

## T005 — the role was never wrong; the prose was

`init-audit-user.sh` defines the write-only role as:

```json
"index_patterns": ["mcm-agent-audit-*", "mcm-agent-audit"],
```

**Both** patterns — the wildcard and the exact name. That is why writes to `mcm-agent-audit` have always
worked. No cluster access was needed to establish this; the answer was in the repository.

What was wrong was every piece of **prose** describing it, in three places, each saying only
`mcm-agent-audit-*`:

- `compose.yaml` header — "index/bulk on mcm-agent-audit-*"
- `init-audit-user.sh` header — "write/bulk on mcm-agent-audit-*"
- `init-audit-user.sh` echo — "write-only on mcm-agent-audit-*"

That is the dangerous kind of stale comment: a test written from the prose would have asserted against a
pattern matching **nothing** and passed vacuously. Corrected at all three (T006).

## T007 — the least-privilege check already existed, and was INCOMPLETE

`init-audit-user.sh` already verified, at provisioning time, that the write-only account:

- **writes** → expects 201 ✅
- **search** → expects 403 ✅

FR-006 requires read, search **and** delete to be refused. **Read and delete were never checked** — so an
append-only security sink whose writer could delete its own evidence would have provisioned green.

Both are now asserted, against **the document just written** rather than a random id. That detail is the
point: a wrongly-permissive role answers **404** for a missing doc, which is indistinguishable from a
correct denial if the check is merely "not 200". Against a real id, a permissive role returns **200 and the
document** — unambiguous.

This is cheaper and better than the new test T007 originally called for: the verification runs where the
role is provisioned, so it cannot drift from it.

---

# Deploy A — done on prod (2026-09-13)

```
A4  path.repo: ["/mnt/snapshots"]            static setting took effect after the restart
A5  mcm-agent-audit/_count = 5276            unchanged from the earlier reading
A7  snapshot pre-os3: state SUCCESS          indices ["mcm-agent-audit"], global state excluded,
                                             shards 1/1, 0 failures, source version 2.19.6
```

**5,276 is the number Deploy B must reproduce exactly** (FR-015 / SC-007).

# Deploy B — written, and three tasks moved INTO it

Deploy B is not just the image swap. Three Phase-4 tasks had to move forward, because CI blocks otherwise:

- **T023 (re-key netty)** — the entry is keyed to the **2.x digest**. The moment compose points at 3.x it
  matches nothing, leaving **6 fixable CRITICALs un-allowlisted**, and `infra-image-scan` fails the PR. It
  must be re-keyed in the *same commit* as the image move, not afterwards.
- **T022 (delete bcprov)** — same mechanism, opposite conclusion: keyed to `opensearchproject/opensearch:2`,
  it stops matching and would be reported UNMATCHED. It is **deleted** because 3.x genuinely discharged it.
- **T024/T025 (lift the ceiling)** — FR-005 requires it in the same change, and the guard asserting `<3`
  would red against a tree that deploys 3.x.

The asymmetry is the point: **one entry deleted, one re-keyed.** Deleting netty would un-suppress a live
advisory; leaving it on the 2.x key would report it unmatched. Both wrong, in opposite directions.

Also corrected while writing Deploy B:

- The planned volume name `agent-audit-opensearch-data-v3` **fails the naming gate** (`…-data` suffix is
  the grammar). Renamed to **`agent-audit-opensearch-v3-data`**, which needs no relaxation.
- `compose.prod.yaml` pins the OpenSearch image **twice** — `agent-audit-init` uses it as a client to run
  the provisioning script. Both moved; a `count == 1` assumption would have left the init container on 2.x.
- **A gap in Deploy A as merged**: dev compose referenced the `-snapshots` volume as `external`, and no
  setup doc told anyone to create it. A fresh dev audit bring-up would have failed. `local-dev.md`, both
  compose headers and the prod prerequisite list now name it (and say to chown it).

---

# Deploy B — done on prod (2026-09-13). The history survived.

```
B1  docker volume create agent-audit-opensearch-v3-data      new, empty
B2  prod-audit redeployed                                    OpenSearch 3 up on the new volume
B3  repository re-registered                                 acknowledged
B4  restore                                                  FAILED first time — see below
B5  mcm-agent-audit/_count = 5276                            EXACTLY A5. shards 1/1, 0 failed.
```

**FR-015 / SC-007 satisfied: a 2.19.6 snapshot restored cleanly into OpenSearch 3, document-for-document.**
That was the one genuinely unproven step in the design — upstream lists snapshot/restore as a supported
upgrade method, but nothing in this repository had ever done it.

## B4 failed first, and the cause was mine

```
snapshot_restore_exception ... cannot restore index [mcm-agent-audit] because an open index with
same name already exists in the cluster
```

**`agent-audit-init` recreated it.** That container runs `init-audit-user.sh` at startup, which POSTs a
verification document — and the role carries `create_index`, so the stack **self-provisions** the index on
an empty volume before a restore can land. My Deploy B sequence never accounted for it.

Confirmed rather than assumed before deleting anything: `docs.count = 1`, 4.9 kb — the single init-verify
doc. Stop the init container → delete → restore → **5276**.

**Nothing was at risk.** Two independent copies of the real data existed throughout: the snapshot, and the
untouched 2.x volume. That is the design working exactly as intended — the failure was an inconvenience
rather than an incident, which is the whole reason for keeping the old volume.

The runbook now stops `agent-audit-init` before the restore, takes the acceptance count **before**
restarting it (the init container adds one more doc, so afterwards the count is A5 + 1 — correct, but no
longer comparable), and carries the recovery for anyone who hits it anyway.

## T017 / T020 — verified on OpenSearch 3

`agent-audit-init` re-ran the **updated** provisioning script against 3.x's security plugin:

```
==> Verifying write   (should be 201)   PASS
==> Verifying READ    (should be 403)   PASS   <- added by feature 071
==> Verifying DELETE  (should be 403)   PASS   <- added by feature 071
==> Verifying search  (should be 403)   PASS
```

The role format did **not** change across the major — the risk flagged in FR-006 did not materialise. And
the two checks this feature added are the two that pass here for the first time ever: before 071, an
append-only sink whose writer could read or delete its own evidence would have provisioned green.

`mcm-agent-audit/_count` = **5277** — the restored 5,276 plus the init-verify write, so the write path works
on 3.x (T020).

## A CREDENTIAL LEAK, found by eye while reading those logs

The same log output ended with:

```
  Admin:         admin / <password>
  Write-only:    agent-audit / <password>
```

`agent-audit-init` runs this script **in production**, so both live credentials were in `docker logs`,
Komodo's log view, and anything shipping them. Direct violation of the never-log list.

It was a **dev convenience** that became a production leak when the init container adopted the script, and
nothing re-examined it at that point. **Item #446** tracks rotation; the echo now names *where* the
credentials live rather than what they are, and `no-secret-echo.guard.test.mjs` fails any shell script that
echoes a secret-named variable (mutation-tested; piping into `--password-stdin` is correctly not flagged).

**No gate caught this.** It was found by reading output for an unrelated reason, which is the least
reliable way to find anything.

## T018 / T019 — the two settings that no gate would otherwise watch

**T018 — the heap pin survived the JDK change.**

```
_nodes/jvm -> heap_max_in_bytes: 1073741824   = exactly 1 GiB
```

FR-007's risk did not materialise. Worth having checked: an unpinned OpenSearch defaults to ~4 GB, and on a
shared prod host that is a real regression that nothing in CI watches. `ps` is **not present** in the
OpenSearch 3 image, so the check goes through the `_nodes/jvm` API rather than the process table — the
first attempt failed on `ps: command not found`, which is a tooling answer, not a heap answer.

**T019 — the fail-fast still fires.** Verified locally rather than on prod, since it is pure compose
interpolation:

```
env -u OPENSEARCH_INITIAL_ADMIN_PASSWORD docker compose -f compose.prod.yaml config
  -> exit 1, "required variable OPENSEARCH_INITIAL_ADMIN_PASSWORD is missing"
with the variable set
  -> exit 0
```

Both directions, so the check distinguishes "fails fast" from "fails always".

## T026 — the post-merge sweep proves the discharge

Run **3324** on `main` (`dd5c11e6`): `success`, `Successful in 2m36s` — the real-sweep band, not a 2-second
skip. So CI genuinely pulled and scanned **opensearch:3** with the bcprov entry **deleted** and netty
**re-keyed** to the 3.x digest, and found nothing blocking.

That is the discharge proven by the gate rather than asserted by us — the whole reason the allowlist changes
had to land in the same commit as the image move.

The `infra-image-scan/expiry` reporter fired alongside (`event_name=push expiry_step=skipped`), correct for
a push event.

## What remains: T021 only

The rollback drill (FR-009) is **unexercised**. It is now genuinely cheap and non-destructive — the 2.x
volume was never touched and still holds all 5,276 documents, and 3.x ran entirely on a separate volume — so
reverting is a compose change and a redeploy with nothing at stake.

It could not be rehearsed in dev: the dev host is at **97% disk / 3.4 GB free** and the drill needs both
OpenSearch images (~3 GB each extracted). The `df` call itself timed out at 120 s under that pressure.

The residual is therefore an argument rather than a measurement: a 2.x node starting on a volume a 3.x node
never opened. The only shared resource is the snapshot volume, which 3.x only **read**. Strong, but FR-009
asks for the measurement, so this is recorded as open rather than waved through.

---

# T021 — the rollback drill, performed in dev (2026-09-13)

Ran the **whole cycle**, not just the rollback, so the rollback was exercised against a cluster that had
actually been through the upgrade — on the same image digests as prod.

| Step | Result |
|---|---|
| 2.x on `agent-audit-opensearch-data`, seed 250 docs | `BEFORE = 250` |
| Register repo + snapshot (Deploy A) | `state SUCCESS`, shards 1/1, failed 0 |
| 3.x on a **new empty** volume, restore (Deploy B) | shards 1/1 failed 0 — **250/250** |
| **ROLLBACK: 2.x on the ORIGINAL volume** | **250/250 intact** |
| Version check after rollback | server self-reports **`2.19.6`** |

The last row matters: the version comes from the **server**, not a container label, so "we are really back
on 2.x" is measured rather than inferred — the same discriminator the Langfuse drill used with
`/api/public/traces` 200↔404.

**The prod rollback claim is now measured, not argued.** A 2.x node opens the original data volume that a
3.x node never touched, and every document is there.

## Two instrument notes from the drill

**My readiness probe was wrong.** I polled `curl … /_cluster/health` for *exit code 0*, and it passed while
the body read `OpenSearch Security not initialized.` — the security plugin was still bootstrapping on the
fresh volume. Checking the exit code instead of the content, in a session that has repeatedly punished
exactly that. The probe now greps for `"status"` in the body.

**The cluster is permanently YELLOW, and always was.** After the rollback health showed `yellow` /
`unassigned_shards: 2`, which looked like damage. It is not:

```
yellow  mcm-agent-audit               250  pri 1  rep 1
yellow  security-auditlog-2026.09.13    5  pri 1  rep 1
```

`rep=1` on a **single-node** cluster can never be assigned. The earlier `green` reading was taken *before*
the index existed, so it was never evidence of anything. **Prod is almost certainly the same**, and the
compose healthcheck only checks that `_cluster/health` responds, not what it says — so nothing is masked
today, but a genuine yellow would be indistinguishable from this permanent one.
