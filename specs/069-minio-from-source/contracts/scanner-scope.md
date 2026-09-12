# Contract: the scanner scope partition

**Owner**: `scripts/infra-image-scan.mjs`
**Enforced by**: `scripts/__tests__/infra-image-scan.test.mjs`, run in `guardrails / naming`

---

## The invariant

> Every container image this project **publishes or pulls** is examined by **exactly one** scanner.
> Not zero. Not two.

The organising rule is **an image is scanned by whoever builds it; everything else is scanned by
`infra-image-scan`**:

| Scanner | Scope | Gate |
|---|---|---|
| `cd-deploy`'s Trivy step | the six images cd-deploy builds | blocks promotion |
| `minio-image`'s Trivy step | `jumbleknot/minio`, which it builds | **blocks the publish** |
| `infra-image-scan` | every other image referenced in `infrastructure-as-code/**` | blocks the merge |

Disjointness is already asserted by a unit test. **Completeness was not**, and that is the gap this
feature closes.

> **Corrected during implementation.** This feature first routed `jumbleknot/minio` to
> `infra-image-scan`. That failed in CI (run 3121: *"unable to find the specified image"*) for a reason
> the design should have anticipated — `infra-image-scan` is **keyless by design**, its own header
> stating it references no `${{ secrets }}`, and the image lives in a **private** registry. Covering it
> there would have meant handing credentials to the keyless scanner *and* scanning only after
> publication.
>
> Its builder already holds the freshly-built image in the local daemon and is already authenticated,
> so scanning there needs no new credential and gates the push rather than auditing it afterwards.
> That is also what cd-deploy has always done — the precedent was in the architecture the whole time.

---

## The defect being fixed

The exclusion is currently written as a prefix test:

```js
if (ref.includes('jumbleknot/')) continue;   // our built images (cd-deploy owns them)
```

The comment states the correct intent. The code implements a different rule — *"exclude anything named
like ours"* rather than *"exclude what cd-deploy already scans"*. The two coincided only because, until
now, every `jumbleknot/*` image happened to be a cd-deploy image.

`jumbleknot/minio` breaks that coincidence: built by us, **not** built by cd-deploy. Under the current
rule it is excluded from `infra-image-scan` and absent from cd-deploy's set — published and examined by
nothing, with no error anywhere. A scan reporting zero findings would be truthful and meaningless.

This is the repository's recurring failure shape: a description standing in for a property.

---

## The corrected rule

Exclude by membership of cd-deploy's actual built set, which is already declared in the same file:

```js
const BUILT_IMAGE_NAMES = ['mcm-bff', 'mc-service', 'agent-gateway',
                           'movie-mcp', 'web-api-mcp', 'spreadsheet-mcp'];
```

An image is excluded from `infra-image-scan` **iff** cd-deploy scans it. The rule now means what the
comment always said.

---

## Required assertions

A guard must fail if any of these stop holding:

1. **Completeness** — enumerate every image reference under `infrastructure-as-code/**`; every one is
   either in `BUILT_IMAGE_NAMES` (cd-deploy's) or enumerated by `infra-image-scan` (ours). Nothing in
   neither.
2. **Disjointness** — nothing in both. (Already asserted; must keep holding.)
3. **The specific regression** — a `jumbleknot/`-namespaced image that is **not** in
   `BUILT_IMAGE_NAMES` is enumerated by `infra-image-scan`. This is the case the old rule got wrong,
   and it must be asserted directly with a fixture, not left implied by assertion 1.
4. **The control** — a genuine cd-deploy image is still excluded. A rule that scans everything would
   satisfy 1 and 3 while double-scanning, violating 2.

Assertion 3 is the one that would have caught this defect, and it is written as a fixture rather than
relying on the real tree — otherwise it silently stops testing anything the day MinIO is the only such
image and someone removes it.

---

## Consequence: the floating-tag exception set empties

`infra-image-scan.test.mjs` asserts the floating-tag exception set equals exactly the two MinIO refs,
and `docs/runbooks/infra-image-scanning.md` states:

> **A floating count of 0 is therefore a FAILURE, not a success** — it would mean the classifier had
> been widened to hide the exceptions rather than declare them. So is a count above 2.

That premise is protecting against a real failure: someone teaching `isFloatingTag` to vouch for an
ordering it does not have, so the report reads clean.

This change empties the set **legitimately** — by removing the images from the pulled set entirely, not
by weakening the classifier. Those two situations produce the same count and must not produce the same
verdict.

**Required**: the guard is rewritten to assert the new premise — the exception set equals the declared
list, whatever that list currently contains, and the declared list is empty *because no pulled image
carries an unorderable tag*. The runbook passage is updated in the same change, because a runbook
asserting "0 is a FAILURE" alongside a codebase where 0 is correct is worse than either alone.

**Prohibited**: deleting the guard, or relaxing it to "0 or 2 is fine". Per CLAUDE.md — a guard that
fails because you changed what it protects gets updated at the cause, never deleted.
