# Phase 0 Research: MinIO built from source

All items below were measured on 2026-09-11, not assumed. Where a fact could not be established from
here, it is marked as an open verification carried into implementation rather than guessed.

---

## R1 — Is a registry switch a real alternative?

**Decision**: No. Build from source.

**Rationale**: `quay.io/minio/minio` and `quay.io/minio/mc` both still exist and are public, so a
registry switch *appears* viable. It is not, because the images there are frozen at the same point
Docker Hub's were. The decisive evidence is a version comparison, not a claim about intent:

| | newest in any registry | newest in source |
|---|---|---|
| `minio` | `RELEASE.2025-09-07T16-13-09Z` (+ a `.hotfix.7aa24e772` variant) | **`RELEASE.2025-10-15T17-29-55Z`**, titled *"Security/CVE"* |
| `mc` | `RELEASE.2025-08-13T08-35-41Z` | `RELEASE.2025-08-13T08-35-41Z` — current |

A security release exists in source that no registry ever received. Switching registry inherits that
gap and every future one.

**Alternatives considered**: Switch to Quay (rejected — above). Mirror the deleted Docker Hub images
into the forge registry (rejected — it preserves exactly the staleness that is the problem, and we
cannot mirror what has been deleted). Drop MinIO for another S3 implementation (rejected as
out-of-scope churn; it replaces a packaging problem with a data-migration problem).

---

## R2 — What exactly does upstream build, and what must we reproduce?

**Decision**: `CGO_ENABLED=0 go build -tags kqueue -trimpath --ldflags "<generated stamp>"`.

**Rationale**: Read from each project's `Makefile` at the pinned tag. The MinIO `Makefile` builds with

```
CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) go build -tags kqueue -trimpath --ldflags "$(LDFLAGS)"
```

where `LDFLAGS := $(shell go run buildscripts/gen-ldflags.go)`. The stamp is **not cosmetic**: it sets
the version string the binary reports, and the stack's health check is `mc ready local`, with `mc` and
`minio` both participating in version-aware behaviour. A binary built without the stamp starts but
misreports itself — it would pass a naive build check and behave oddly in service.

`CGO_ENABLED=0` is what makes the runtime base a free choice, because the output has no libc linkage.

**Alternatives considered**: `go install` without flags (rejected — loses `-trimpath` reproducibility
and the version stamp). Invoking upstream's `make` directly (a reasonable option; deferred to
implementation, since `make` pulls in more of the upstream build environment than the two `go build`
invocations we actually need — whichever is used, the flags above are the contract).

---

## R3 — Can one builder compile both, hermetically?

**Decision**: Yes. One `golang:1.25-alpine` builder with `GOTOOLCHAIN=local`.

**Rationale**: Measured from each module's `go.mod` at the pinned tag:

| module | `go` directive | `toolchain` directive |
|---|---|---|
| `minio` | `go 1.24.0` | `go1.24.2` |
| `mc` | `go 1.23.0` | `go1.23.10` |

A local toolchain newer than both satisfies both. `GOTOOLCHAIN=local` forces the bundled compiler and
**suppresses the automatic toolchain download** the `toolchain` directives would otherwise trigger —
which matters twice over: it makes the build hermetic (no network fetch of a compiler mid-build), and
it means the Go version is a pinned input we choose rather than something upstream chooses for us.

Choosing the newest available builder is the point. `CVE-2025-68121` — the Go **stdlib** Critical that
sits un-dischargeable in the allowlist against `postgres`, `mongodb`, `vault` *and* `minio` — exists
precisely because those images were built with an old Go. Building ourselves converts that from an
allowlist entry into a build input.

`golang:1.25-alpine` (pushed 2026-08-19) is materially newer than `golang:1.24-alpine` (2026-02-08).
Pin it by digest.

**Alternatives considered**: Two builder stages at the exact upstream toolchains (rejected — doubles
build time and deliberately reproduces the old stdlib we are trying to escape). Letting Go download
the `toolchain` versions (rejected — a network fetch inside the build, and it discards the control
that motivates the change).

---

## R4 — How is upstream source pinned against an untrustworthy upstream?

**Decision**: Pin **release tag *and* commit SHA**. Both appear in the Dockerfile as build args.

**Rationale**: A git tag is mutable, and the threat model here is not hypothetical — this whole change
exists because the upstream publisher deleted artifacts we depended on. A tag alone would let a moved
tag silently produce a different binary under the same version string.

Resolved, including dereferencing the **annotated** tag objects (the first lookup returns a tag object,
not the commit — taking `object.sha` from it without dereferencing pins the wrong thing):

| module | release tag | tag object | **commit** |
|---|---|---|---|
| `minio` | `RELEASE.2025-09-07T16-13-09Z` | `01ce918d…` | **`07c3a429bfed433e49018cb0f78a52145d4bedeb`** |
| `mc` | `RELEASE.2025-08-13T08-35-41Z` | `d6541ea2…` | **`7394ce0dd2a80935aded936b09fa12cbb3cb8096`** |

The build fetches the tag and then asserts `HEAD` equals the pinned commit, failing loudly on a
mismatch.

**Alternatives considered**: Tag only (rejected — see above). Vendoring the source into this repository
(rejected — megabytes of third-party Go into git, and it makes the next version bump a vendoring
exercise instead of a two-line argument change).

---

## R5 — Which runtime identity, and what does the live volume require?

**Decision**: Run as **root**, matching the replaced image exactly. Non-root is deliberately deferred.

**Rationale**: Measured by pulling the upstream image's config blob from Quay (the only registry still
serving it):

```
User:       <unset>   -> root
Entrypoint: ["/usr/bin/docker-entrypoint.sh"]
Cmd:        ["minio"]
Volumes:    {"/data": {}}
```

The live `langfuse-minio-data` volume was therefore created and written by a root process. A replacement
running as a non-root uid could not write to it, and the failure would land on a production redeploy
holding real objects. Changing identity *and* packaging in one step would also make any failure
unattributable.

This is a knowing step sideways from "production-ready", accepted for one change and recorded in the
spec (FR-015) rather than left implicit.

**Open verification carried into implementation**: the volume's ownership is *inferred* from the
image's published configuration, not *observed* on the running host. A task must confirm it against the
real volume before the production rollout.

**Alternatives considered**: Non-root plus a one-time `chown` in this change (rejected — couples a
data-ownership migration to a packaging change on a stateful service). Non-root with an init container
that fixes ownership (rejected for the same reason, plus it adds a container to the critical path).

---

## R6 — Do we still need the entrypoint wrapper?

**Decision**: No. `ENTRYPOINT ["minio"]`, no `docker-entrypoint.sh`.

**Rationale**: The upstream wrapper exists to translate `MINIO_*_FILE` secret-file variants into
environment variables and to optionally drop privileges to `MINIO_USERNAME`. This stack uses neither —
compose passes `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` directly, and sets no `MINIO_USERNAME`. With
`ENTRYPOINT ["minio"]`, the existing `command: ["server", "/data", "--console-address", ":9001"]`
composes into exactly the same process invocation as today.

Reimplementing the wrapper would be carrying a compatibility shim for behaviour nothing here uses.

**Alternatives considered**: Port the upstream wrapper (rejected — unused surface area). Fold the
command into the Dockerfile `CMD` (rejected — it would duplicate what compose already states, and split
one decision across two files).

---

## R7 — Which scanner owns the new image?

**Decision**: `infra-image-scan`. This requires **tightening its exclusion rule**, which is the
substantive engineering in this change.

**Rationale**: The project has two scanners with deliberately disjoint scopes — `cd-deploy`'s Trivy
step covers the six images it builds, `infra-image-scan` covers third-party images it pulls. The
exclusion is currently a blanket prefix test:

```js
if (ref.includes('jumbleknot/')) continue;   // our built images (cd-deploy owns them)
```

That comment states the intent correctly and the code does not implement it. A `jumbleknot/minio`
built *outside* cd-deploy matches the exclusion but is not in cd-deploy's set, so it would be published
**unexamined by either scanner, silently**. The correct rule excludes cd-deploy's actual
`BUILT_IMAGE_NAMES`, which is already a list in the same file.

This is a latent hole for *any* future built-outside-cd-deploy artifact, not just ours — fixing the
rule rather than special-casing MinIO is what stops the next one.

**Consequence that must be handled, not worked around**: `infra-image-scan.test.mjs` asserts the
floating-tag set equals exactly the two MinIO refs, and the runbook states *"a floating count of 0 is a
FAILURE, not a success"* — that premise exists so nobody widens the classifier to hide the exceptions.
Removing both refs makes the count 0 legitimately. The guard must be **updated at the cause** to assert
the new premise, never deleted or relaxed.

**Alternatives considered**: Join cd-deploy as a 7th built image (rejected — a full Go build on every
deployable main push, on a capacity-1 runner already carrying a 28-minute app-e2e). A third scan path
inside the new workflow (rejected — a third allowlist and a third place to look, and it leaves the
blanket-exclusion hole open).

---

## R8 — What build cadence?

**Decision**: Dispatch, plus Dockerfile/version change, plus a weekly cron — but the two automatic
triggers do **different jobs**, and conflating them is a mistake this section previously made.

**Corrected during `/speckit-analyze`.** An earlier draft claimed "the weekly rebuild is the mechanism
by which a Go stdlib or Alpine patch reaches the image". That is **false given our own design**: §R3
and §R4 pin the builder and runtime images *by digest*. A rebuild with no input change therefore has
identical inputs and produces an equivalent image. A cron cannot pull in a patch that nothing has
pointed us at.

**Corrected a SECOND time, 2026-09-11, by measurement.** The `/speckit-analyze` correction above was
also wrong — less wrong, but wrong. It asserted a no-change rebuild "produces an equivalent image".
Two consecutive CI builds of identical source produced **different digests**:

```
run 3115  sha256:7038b9e9…
run 3117  sha256:1e981fa1…     identical inputs, different image
```

The cause is in this Dockerfile, not in Docker: `apk add --no-cache ca-certificates` (runtime) and
`apk add --no-cache git` (builder) resolve against Alpine's **live** package index at build time. The
base images are digest-pinned; the packages installed *into* them are not.

So the build is **not bit-reproducible**, and the honest split is narrower than the first claim and
broader than the second:

| Input | Pinned? | Reaches the image via |
|---|---|---|
| Base images (golang, alpine) | digest-pinned | **Renovate digest bump** → push trigger |
| Go toolchain | inside the pinned builder | **Renovate digest bump** → push trigger |
| Go modules | go.mod / go.sum at the pinned commit | upstream source bump |
| **apk packages** (`ca-certificates`, `git`) | **NOT pinned — float** | **the weekly cron** |

The cron therefore *does* have a patch path, but a narrow one: Alpine package updates only. It is
still mostly a canary, and calling it "the" patch path for Go-stdlib or base-image CVEs remains wrong.

**Recorded because the reasoning was wrong twice.** Both errors were confident and both were about the
same question. What settled it was comparing two real digests — not argument. If bit-reproducibility
is ever actually wanted, the apk installs must be version-pinned too, and that is a separate decision
with its own maintenance cost; it is not the current design and this document should not imply it is.

### R8a — non-reproducibility has a second consequence, and it is the dangerous one

**Measured 2026-09-12.** Rebuilding and re-pushing the same release tag left the *previous* digest
returning **404** — not superseded, **gone**:

```
compose pinned  sha256:d876e7b3…   ->  HTTP 404, docker pull: "not found"
registry now    sha256:469c132a…
```

This registry drops a manifest as soon as no tag references it. Combine that with a build that is not
bit-reproducible and the weekly canary becomes actively harmful: every Friday it would mint a new
digest, re-point the release tag, orphan the old manifest, and **break every compose reference pinned
to it — dev and production alike**. A job whose entire purpose is to prove the build still works would
have been breaking the stack on a schedule.

The fix is the pattern this repository already uses and which I failed to copy: `cd-deploy` and
`devcontainer-image` tag by `GITHUB_SHA`, so their tags never collide and no manifest is ever orphaned.
Tagging by the *upstream release* — stable across rebuilds by construction — was the mistake.

Each build now pushes **two** tags: the moving release tag (`2025.09.07-161309`), which is what a human
reads, and an immutable per-run tag (`…-r<run id>`), which keeps that exact manifest referenced for
ever. A digest pinned in compose therefore stays pullable, and updating it becomes a deliberate act
rather than a weekly breakage.

**Verified, not reasoned.** The argument — run IDs are unique, so `…-r3127` can never be re-pushed, so
its manifest stays referenced — is sound, and this feature has repeatedly shown that sound arguments
lose to measurements. So it was tested directly:

```
run 3127  publishes  4dcaddaa…   tagged 2025.09.07-161309 AND 2025.09.07-161309-r3127
run 3128  rebuilds:  release tag moves to 9d2af9ab…
          then:      GET manifests/sha256:4dcaddaa…  ->  HTTP 200   (previously: 404)
```

The pinned digest survives a subsequent rebuild. Compose references no longer break when the canary
runs.

**The general lesson, worth more than the fix:** "the digest changed" and "the old digest stopped
existing" are different failures with the same symptom, and only the second one breaks things that
were already deployed. I noticed the first three times before checking for the second.

**Alternatives considered**: On-change only (rejected — loses the canary, and the canary is the part
that protects against an upstream that has already shown it will delete things). Tracking base images
by tag instead of digest so the cron *does* pull patches (rejected — it trades reproducibility for a
worse version of what Renovate already does well, and silently changes what a given image contains).
Daily (rejected — capacity-1 runner; nothing changes that fast).

---

## Residual risks accepted

- **Upstream source could be removed too.** We fetch from the organisation that just deleted its
  images. The build fails loudly if so, and the last published image remains in our own registry — a
  strictly better position than today. Not engineered around.
- **Maintenance transfers to us.** Noticing and responding to MinIO vulnerabilities becomes the
  project's job. The weekly rebuild is the mechanism; the commitment is real and ongoing.
