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
