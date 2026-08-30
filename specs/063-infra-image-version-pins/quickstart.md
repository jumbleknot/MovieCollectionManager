# Quickstart: validating the infra-image version pins

**Feature**: 063-infra-image-version-pins

## Prerequisites

- Docker available; `auth.docker.io` and `registry-1.docker.io` reachable.
  `hub.docker.com` is **not** reachable from the dev container — use the registry v2 API.
- Trivy is **not** installable here: its install script resolves a version and then downloads nothing
  (egress seam, exit 0, no binary). Run it from its image, and redirect **both** databases — omitting
  `--java-db-repository` makes JVM images fail deep in layer analysis, which reads like a scan failure
  rather than a config gap. See `docs/runbooks/infra-image-scanning.md`.

## 1. The floating count matches the declared exceptions (SC-006)

```bash
node scripts/infra-image-scan.mjs --list | grep -c "floating tag"   # expect: 2
node scripts/infra-image-scan.mjs --list | grep "floating tag"      # expect: minio/minio, minio/mc only
```

Any other image appearing here is a failure, **and so is a count of 0** — that would mean the
classifier was widened to hide the declared exceptions rather than declare them (research R4).

## 2. The migration is content-neutral (SC-002)

For each substituted reference, the digest before and after must be identical:

```bash
TOKEN=$(curl -sS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:<repo>:pull" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")
curl -sS -I -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json" \
  "https://registry-1.docker.io/v2/<repo>/manifests/<new-tag>" | grep -i docker-content-digest
```

Compare against the digest in the compose file **before** the change. All eight must match.

## 3. Resolved classification and grouping (C1, C2)

```bash
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
```

Expect every C1/C2 assertion to pass. These are the tests that must have been RED before the Renovate
configuration landed.

## 4. The CVE gate still passes, for the right reason (FR-007)

```bash
node scripts/check-infra-image-findings.mjs --selftest   # detection works
node scripts/check-infra-image-findings.mjs              # against a fresh scan report
```

A pass is only meaningful if the suppressions are still matching. Confirm by checking that the
re-keyed entries appear under "Allowlisted" in the summary rather than silently matching nothing —
an entry that matches nothing is reported as unmatched, which is the signal that a re-key went wrong.

## 5. Full suite

```bash
node --test scripts/__tests__/*.test.mjs      # expect 0 failed, 0 skipped
node scripts/check-toolchain-consistency.mjs
```

## What "done" looks like

- 2 floating references, both declared exceptions, named in `renovate.json`
- 8 digests unchanged
- every C1 classification assertion resolving to a real update type, none to `digest`
- `infra-image-scan / infra-image-scan` green in CI on the pull request

---

## Observation (T014, US3): does `renovate/stability-days` settle once these are version-pinned?

**Status as of 2026-08-30: window OPEN, not yet observable. No PR number to record yet.**

This is US3's acceptance scenario and the evidence backlog item **#298** is waiting on. It is
upstream-timed and deliberately carries no RED/GREEN cycle: forcing it would falsify it.

### Why it cannot be recorded yet

The observation needs a Renovate proposal **for one of the eight formerly-floating images**, and one
cannot exist until these pins are on `main`. The open PRs on 2026-08-30 were checked and neither
qualifies:

| PR | branch | why it does not answer the question |
|---|---|---|
| #288 | `renovate/lock-file-maintenance-cargo-deps` | lockfile-refresh channel, no docker image involved; empty, awaiting autoclose |
| #263 | `renovate/js-patchminor` | npm channel; parked on its own release-age cooldown until 2026-08-31 17:58Z |

### What to record, on the next `docker base images` PR after this merges

The mechanism under test (item #297 harm 2, item #298's "why it recurs"): a frequently-rebuilt
`latest` image made Renovate re-pin to a new digest on each config regeneration, **resetting the
3-day `minimumReleaseAge` clock**, so `renovate/stability-days` sat pending indefinitely. Measured on
PR #289: the nightly run re-posted `pending — Updates have not met minimum release age requirement`
at 2026-08-30T03:05:16Z — a live evaluation, not a stale status. A version tag should change that,
because a release is a discrete event rather than a rolling rebuild.

Record, against the PR number:

1. Whether `renovate/stability-days` reaches **success on its own**, without the PR being merged past
   it — the thing no one has yet observed happening on this repository at all.
2. How long it took from branch creation, versus the configured 3 days.
3. Whether a nightly regeneration **reset** the clock: compare the check's `started_at` across
   consecutive nightly runs on the same branch. A reset shows as the timestamp advancing while the
   proposed version stays put.
4. Whether the eight formerly-floating images were in that PR at all (they ride `docker base images`;
   if none of them moved, the run says nothing about this question).

> **Do not close #298 on the strength of this.** #298 asks what policy should govern *merging past* a
> pending cooldown; this observation only supplies one input — whether the control can now be
> satisfied for this group. A single green `stability-days` does not decide the policy, and the item
> is explicitly open and undecided.

> **Never hand-close a Renovate PR to move this along.** Closing marks the update *rejected*, and
> Renovate will not re-propose it.
