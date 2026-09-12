# Implementation Plan: OpenSearch 2 → 3 for the agent-audit sink

**Spec**: [spec.md](./spec.md) · **Decision**: [ADR-0002](../../docs/decisions/ADR-0002-stateful-major-upgrades.md)
· **Backlog**: item #407

**Primary dependencies**: `opensearchproject/opensearch:3` (upstream, pulled — not built here);
`infrastructure-as-code/docker/opensearch/compose{,.prod}.yaml`; Komodo ResourceSync stack `prod-audit`
(`infrastructure-as-code/komodo/stacks.toml`); `renovate.json` packageRule 19;
`security/infra-images/allowlist.yaml`; the infra-image gate (`scripts/check-infra-image-findings.mjs`).

**No application code changes.** The BFF and agent gateway reach the sink over its existing interface; this
feature does not touch `backend/`, `agents/`, `frontend/` or `mcp-servers/`.

## Approach

The feature is structured as **a gate, then a narrow change**. That ordering is the whole design: almost all
the risk is concentrated in a question that costs one CI run to answer, and the remaining work is a
two-file digest move plus two deletions.

```
Phase 0  GATE    scan opensearch:3 → does it clear CVE-2025-14813 and CVE-2026-75595?
                   │
         ┌─────────┴──────────┐
       both clear         either remains
         │                    │
Phase 1  local bring-up   ADR-0002 §6 fallback: re-date both entries naming the
Phase 2  prod cutover     scanned digest, keep allowedVersions "<3", close #407
Phase 3  rollback drill   against the ADR. STOP — no compose/renovate change.
Phase 4  delete entries
```

Phase 0 produces a written artifact (`research.md`) whichever way it goes. A gate whose negative result is
not recorded is a gate that gets re-litigated in three months.

## Why the gate is a phase and not a task

Because it can **end the feature**, and because the cost asymmetry is extreme: one scan versus a production
data migration undertaken for a remediation that may not exist. Feature 036 is the precedent — it moved
mongo on the assumption that newer meant fixed, found the same pre-fix binary *and* an unhealthy container
on CI, and reverted. The mongo allowlist entry still carries that story.

The scan must name a **digest** (FR-001). `:3` is a floating major; a result recorded against it cannot be
re-checked once the tag moves, which is the same un-dischargeable-key problem item #297 fixed for allowlist
entries.

## Sequencing, which is the part that matters

**Phase 0 — the gate.** Resolve `opensearch:3` to a digest; scan it with `--severity CRITICAL
--ignore-unfixed`; record per-advisory presence/absence plus the bundled `bcprov-*` jar names and the netty
version, because those are what the current justifications assert and what a future re-triage will compare
against. Run it where Trivy is authoritative (FR-002).

**Phase 1 — local, on a fresh volume.** Move `compose.yaml` to the pinned 3.x digest. Bring up
`--profile audit`. Three things get checked that a healthcheck does not cover: the write-only `agent-audit`
account still writes *and* is still refused read/search/delete (FR-006); the 1 GB heap pin still binds under
the newer JDK (FR-007); and the `${VAR:?}` fail-fast on a missing admin password still fires (US-2 #4).
OpenSearch 3 is the most likely place for the security-plugin configuration to have changed shape, so
provisioning that account is the task most likely to expand — it is sequenced early for that reason.

**Phase 2 — production.** Move `compose.prod.yaml` and let Komodo redeploy `prod-audit` onto a recreated
volume. Verified by an **actual write from the gateway's write-only account** (SC-003), not by a healthcheck:
a healthy OpenSearch with a broken audit role is exactly the failure this stack would hide, since the writer
never reads.

**Phase 3 — the rollback drill.** Revert the digest, recreate the volume, confirm a healthy 2.x stack
(FR-009). Done *after* cutover rather than before, so it exercises the real path. The data not returning is
the ratified outcome, not a failure — ADR-0002 §4.

**Phase 4 — the deletions.** Remove both entries from the allowlist. This is last because it is the step
whose success is *proved by CI*: editing `security/infra-images/**` forces a real sweep, so the gate passing
with the entries gone is the discharge. Lifting packageRule 19's ceiling lands in the same change (FR-005),
rewriting its description to record the outcome rather than deleting the text.

## Testing strategy

There is no unit-testable logic here; the artifacts are compose files, a config rule and a YAML allowlist.
The verification is therefore mostly **gates that already exist**, plus one guard that does not:

| What | How |
|---|---|
| The advisories are actually gone | The infra-image gate itself, on a forced real sweep (Phase 4) |
| No entry is left matching nothing | `check-infra-image-findings.mjs --check-expiring` — the weekly tier, which now also publishes its own execution record (item #418) |
| Both compose files moved together | `infra-image-scan.test.mjs` (412) — every third-party ref digest-pinned |
| The ceiling was lifted deliberately | `renovate-workflow.guard.test.mjs` — extend it to assert packageRule 19 either holds `<3` **or** names a scanned digest in its description; the two states are both legal, silence is not |
| Least privilege survived | A test that the `agent-audit` account is refused read/search/delete — **RED first**, against 2.x, since it should pass there too and a test that has only ever seen 3.x proves nothing about what changed |

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
- **`prod-audit` does not come back healthy.** Rollback is a digest revert — but it is only known to work
  once Phase 3 has run, which is why Phase 3 is a phase.
- **Item #406's entries expire mid-flight (2026-10-01).** If this feature is still open then, the entries
  must be re-dated rather than allowed to red the weekly check on an unrelated branch. That is the
  behaviour f7fea0f6 documented; the warning tier opens 2026-09-17 and is the signal to act.
