# Contract: Evidence bundle

**Feature**: 042-ci-self-serve-diagnostics | Write side (US3)

## Identity

Forge **generic package registry**:

```
/api/packages/{owner}/generic/ci-failures/{runId}--{jobSlug}/bundle.json.gz
```

| Component | Value |
|---|---|
| Package | `ci-failures` (constant) |
| Version | `{runId}--{jobSlug}` — **per run *and* job** |
| File | `bundle.json.gz` |

> **Format changed during implementation (2026-07-19): `bundle.tar.zst` → `bundle.json.gz`.**
> The original choice would have required either a `zstd` binary on every runner (not guaranteed on
> `node:22-bookworm`) or a tar/zstd npm dependency — and the whole script family is deliberately
> zero-dependency, `node:` built-ins only, because `guardrails` runs with nothing installed. Node
> ships `zlib` in core, so a single gzipped JSON manifest gets the same content with no new
> dependency and no new binary. The trade-off is that a `.tar.zst` is browsable with standard tools
> while this needs one command to expand — which is why `ci-status failure --full` **extracts the
> manifest into a real directory tree** on retrieval, so a human still browses files, not JSON.

The job slug is normalised (`[^A-Za-z0-9._-]` → `-`), so a context like
`infra-image-scan / infra-image-scan` yields a valid package version.

**Why the job is in the key** (clarified FR-006): keying by run alone lets two jobs failing in the same
run overwrite each other, and jobs fail together routinely — a cancelled run fails every context at
once. The `--` separator avoids ambiguity with numeric run ids and hyphenated job names.

## Contents

```text
bundle.json.gz            # gzipped manifest: { meta, files: [{ path, text }] }

…which `--full` extracts to:

<scratchpad>/{runId}--{jobSlug}/
├── digest.md             # the digest itself — for a non-PR failure this is the ONLY copy (FR-008)
├── meta.json             # workflow, job, step, sha, pr, runId, truncation record, absent list,
│                         #   and `publish` = {published, channel, reason} so a FAILED publish is
│                         #   diagnosable over the API (the job log is not)
├── logs/
│   └── <container>.log   # full docker logs (kvm jobs only)
└── health/
    └── <container>.json  # full .State.Health — the literal "why unhealthy"
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
