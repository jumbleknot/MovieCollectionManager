# Implementation Plan: OpenSearch 2 → 3 for the agent-audit sink

**Spec**: [spec.md](./spec.md) · **Decision**: [ADR-0002](../../docs/decisions/ADR-0002-stateful-major-upgrades.md)
· **Backlog**: item #407

**Primary dependencies**: `opensearchproject/opensearch:3` (upstream, pulled — not built here);
`infrastructure-as-code/docker/opensearch/compose{,.prod}.yaml`; Komodo ResourceSync stack `prod-audit`
(`infrastructure-as-code/komodo/stacks.toml`); `renovate.json` packageRule 19;
`security/infra-images/allowlist.yaml`; the infra-image gate (`scripts/check-infra-image-findings.mjs`).

**No application code changes.** The BFF and agent gateway reach the sink over its existing interface; this
feature does not touch `backend/`, `agents/`, `frontend/` or `mcp-servers/`.

## Approach — REVISED 2026-09-13: two deploys, because `path.repo` is static

The gate ran and came back **split**: bcprov discharged, netty not (see [research.md](./research.md)).
[ADR-0002 §4a](../../docs/decisions/ADR-0002-stateful-major-upgrades.md) then reversed the data decision —
the 5,276-document audit history is **preserved** via snapshot and restore.

That reshapes the plan around one constraint: **`path.repo` is a static OpenSearch setting.** A node cannot
register a filesystem snapshot repository unless it was started with that path configured. The 2.x node is
running *now* without one. So the snapshot cannot be taken until the 2.x node has been restarted with the
repository volume mounted — which is a compose change, deployed **while still on 2.x**.

```
DEPLOY A (still on 2.x)   add the snapshot volume + path.repo   -> restart -> register repo -> SNAPSHOT
DEPLOY B (the upgrade)    image -> 3.x, RECREATE the data vol,  -> restore -> verify 5,276 docs
                          KEEP the snapshot vol
```

**Two deploys, not one, and the order is not negotiable.** Squeezing it into one would mean either
snapshotting before the repo exists (impossible) or recreating the data volume before the snapshot is taken
(data gone).

## Why the snapshot repository gets its own volume

FR-016. If the repository lived inside the OpenSearch data volume, Deploy B's `docker volume rm` would
destroy the snapshot at the exact moment it becomes the only copy. Separate volume, and it is **not**
recreated in Deploy B.

## The 2.x data volume is KEPT, not recreated — which makes this nearly risk-free

The Langfuse cutover recreated its volume in place, because its data was being discarded anyway. Here the
data matters, so Deploy B does something better: **3.x starts on a NEW, empty data volume, and the 2.x
volume is left untouched.**

```
observability/agent-audit-opensearch-data      <- 2.x data. UNTOUCHED. The rollback.
agent-audit-opensearch-snapshots               <- the snapshot. Its own volume (FR-016).
agent-audit-opensearch-data-v3                 <- 3.x starts here, empty.
```

Consequences worth stating, because they invert the risk profile of this feature:

- **Rollback is no longer lossy.** Revert the compose to 2.x pointing at the original volume and the 5,276
  documents are exactly where they were. Contrast ADR-0002 §4's original position, where rollback returned a
  healthy-but-empty stack.
- **There are two independent copies** during the cutover — the original volume and the snapshot — so the
  restore failing is an inconvenience, not an incident.
- **Nothing irreversible happens** until someone deletes the old volume, which is a separate, deliberate
  step **after** the restore is verified, and is not part of this feature.

The old volume is therefore deliberately left behind as debris. That is the correct trade: a stale 327 kb
volume is cheaper than an unrecoverable audit trail.

## What the restore is verified against

**An exact document count, not a health check.** `mcm-agent-audit` had 5,276 documents when measured; the
sink is live, so the number is re-measured immediately before the snapshot and that figure is what the
restore must reproduce. This is a stronger check than anything else in the feature: "the stack came up" says
nothing about whether 5,276 audit events survived.

## The FR-006 pattern bug must be resolved BEFORE US-2 is verified

The spec and the compose header both say the write-only account holds index/bulk on `mcm-agent-audit-*`.
The live index is `mcm-agent-audit`, and that pattern requires a trailing dash. Writes are demonstrably
working (5,276 documents), so the role's real pattern differs from the prose. A least-privilege test written
against `mcm-agent-audit-*` would match nothing and **pass vacuously** — the precise failure it exists to
prevent. Read the actual role before asserting anything.

## Testing strategy

There is no unit-testable logic here; the artifacts are compose files, a config rule and a YAML allowlist.
The verification is therefore mostly **gates that already exist**, plus one guard that does not:

| What | How |
|---|---|
| The advisories are actually gone | The infra-image gate itself, on a forced real sweep (Phase 4) |
| No entry is left matching nothing | `check-infra-image-findings.mjs --check-expiring` — the weekly tier, which now also publishes its own execution record (item #418) |
| Both compose files moved together | `infra-image-scan.test.mjs` (412) — every third-party ref digest-pinned |
| The ceiling was lifted deliberately | `renovate-workflow.guard.test.mjs` — extend it to assert packageRule 19 either holds `<3` **or** names a scanned digest in its description; the two states are both legal, silence is not |
| Least privilege survived | A test that the `agent-audit` account is refused read/search/delete — **RED first**, against 2.x, since it should pass there too and a test that has only ever seen 3.x proves nothing about what changed. Resolve the FR-006 pattern bug first, or it asserts against an index pattern that matches nothing |
| **The audit history survived** | `mcm-agent-audit` document count before == after, exact. The single most load-bearing check in the feature |

The last row is the only new automated test, and it is written and proven RED/GREEN against **2.x** before
the image moves. A privilege test authored after the upgrade cannot distinguish "still correct" from "was
never checked".

## Risks

- **The gate passes for one advisory only.** Handled by US-1 #4 as an explicit recorded judgement. The
  temptation is to treat "50% better" as automatic; the cost side is irreversible data loss, so it is not.
- **OpenSearch 3 changes the security-plugin config format.** Most likely source of scope growth. Mitigation
  is sequencing it into Phase 1 where it is cheap; the rule is that reproducing the read/write split is in
  scope and weakening it to get green is not (FR-006).
- **The heap pin stops binding.** A ~4 GB default on a dev machine already running a large stack is a real
  regression that no gate would catch. Checked explicitly (FR-007).
- **`prod-audit` does not come back healthy.** Rollback is a digest revert plus a restore from the same
  snapshot — which is now strictly better than before: the snapshot is an independent copy, so a failed
  upgrade is recoverable rather than merely revertible.
- **The snapshot is taken but unreadable by 3.x.** The one risk the whole approach rests on. Upstream lists
  snapshot/restore as an upgrade *method* across adjacent majors, so it is supported — but it is verified by
  restoring and counting, not by trusting that. If the restore fails, Deploy B is reverted and the 2.x node
  comes back on its **original data volume**, which Deploy B must therefore not destroy until the restore
  has been verified.
- **Item #406's entries expire mid-flight (2026-10-01).** If this feature is still open then, the entries
  must be re-dated rather than allowed to red the weekly check on an unrelated branch. That is the
  behaviour f7fea0f6 documented; the warning tier opens 2026-09-17 and is the signal to act.
