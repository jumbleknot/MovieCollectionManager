# Contract: Evidence bundle

**Feature**: 042-ci-self-serve-diagnostics | Write side (US3)

## Identity

Forge **generic package registry**:

```
/api/packages/{owner}/generic/ci-failures/{runId}--{jobSlug}/bundle.tar.zst
```

| Component | Value |
|---|---|
| Package | `ci-failures` (constant) |
| Version | `{runId}--{jobSlug}` — **per run *and* job** |
| File | `bundle.tar.zst` |

**Why the job is in the key** (clarified FR-006): keying by run alone lets two jobs failing in the same
run overwrite each other, and jobs fail together routinely — a cancelled run fails every context at
once. The `--` separator avoids ambiguity with numeric run ids and hyphenated job names.

## Contents

```text
bundle.tar.zst
├── meta.json                  # workflow, job, step, sha, pr, runId, timestamps, collector version
├── logs/
│   ├── <container>.log        # full docker logs (kvm jobs only)
│   └── _mcm-stack.log         # compose-level logs where available
├── health/
│   └── <container>.health.json  # full .State.Health — the literal "why unhealthy"
├── ps.txt                     # docker ps -a status table
└── test-output/               # jest / Playwright report / Maestro screenshots where present
```

Everything present is included in full — the bundle is the counterpart to the deliberately small
digest. **Redaction still applies** (FR-005): the bundle is as publishable as the digest, and the same
fail-closed rule governs it.

Container-derived paths exist only on `kvm` jobs; container jobs have no Docker CLI (research R7).
`meta.json` records what was absent so a reader can distinguish "not collected" from "empty".

## Size cap (NFR-003)

**5 MB.** At the measured ~135 KB/s link this is ≈40 s to retrieve — the ceiling for `--full` to stay
usable. On overflow, truncate largest-source-first and record the truncation in `meta.json`, so a
bundle never silently misrepresents itself as complete.

## Retention (FR-021, FR-021a, FR-021b)

- **30 days**, matching the repo's existing general log-retention standard.
- Pruned **opportunistically at publish**: list versions, delete those past the window. **No new
  scheduled pipeline** is introduced.
- A pruning failure **must not fail the publish**, and must not fail the job (FR-021b) — it is logged
  and swallowed like every other write-side error.
- Accepted trade-off: if failures stop entirely, expired bundles linger until the next failure
  publishes. Storage stays bounded by the per-bundle cap.

## Auth

Upload uses `CI_DIGEST_TOKEN` (`write:package`), a **new purpose-scoped Forgejo Actions secret** — not
`CD_PUSH_TOKEN`, which is a whitelisted-user PAT able to push protected `main` and would be a real
privilege expansion across ~20 jobs (research R2).

Retrieval uses the read-only `MCM_FORGE_TOKEN` (`read:package`), already provisioned via the
devcontainer `${localEnv}` passthrough. Verified: package `GET` returns 404 (not 401) with this token —
auth passes, the package simply does not exist yet. Package `PUT` remains 401, which is correct: the
read token must not be able to write.
