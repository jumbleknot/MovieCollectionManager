# Phase 1 Data Model: MinIO built from source

No application data model — this feature ships an image, a build workflow, and a scope rule. The
"entities" the spec names are configuration artifacts, and what matters about each is its identity,
where it lives, and which invariant it participates in.

---

## E1 — Published image

The artifact this feature exists to produce.

| Attribute | Value |
|---|---|
| Repository | `${REGISTRY}/${NS}/minio` (host-free in git; resolved from Forgejo vars) |
| Tag | the upstream server release, e.g. `RELEASE.2025-09-07T16-13-09Z` |
| Addressed by | tag **and** `@sha256:` digest, in every compose reference |
| Contents | `/usr/bin/minio` and `/usr/bin/mc` |
| Runtime identity | root (uid 0) — see E3 |
| Entrypoint | `["minio"]` |

**Validation rules**

- Both binaries MUST be present and executable — the health check invokes `mc` inside this container.
- `minio --version` and `mc --version` MUST report the upstream release, not `DEVELOPMENT` or empty.
- Every compose reference MUST carry a digest. A tag-only reference is a regression to the mutable
  reference this whole feature is a reaction to.

**Relationships**: produced from E2; consumed by the observability stack; classified by E4; formerly
suppressed against by E5.

---

## E2 — Upstream source reference

The unit dependency tracking proposes changes to. Two of these, one per binary.

| Attribute | `minio` | `mc` |
|---|---|---|
| Release tag | `RELEASE.2025-09-07T16-13-09Z` | `RELEASE.2025-08-13T08-35-41Z` |
| Commit SHA | `07c3a429bfed433e49018cb0f78a52145d4bedeb` | `7394ce0dd2a80935aded936b09fa12cbb3cb8096` |
| Expressed as | Dockerfile build args | Dockerfile build args |
| Tracked by | Renovate, `github-releases` datasource, date versioning | same |

**Validation rules**

- The tag and commit MUST agree at build time. The build asserts this and fails on mismatch.
- A version change MUST move the tag and the commit **together**. One without the other is the
  half-bump shape this repository has paid for four times.
- Date versioning MUST be preserved when the datasource moves, or `RELEASE.2025-10-15…` is not
  recognised as newer than `RELEASE.2025-09-07…` and the security bump is never proposed.

**State transition**: `pinned` → (Renovate proposes both args) → `pinned at new release`. There is no
intermediate state in which only one arg has moved; the guard prevents it.

---

## E3 — Object data volume

Pre-existing, and the constraint that shapes most of this design.

| Attribute | Value |
|---|---|
| Name | `langfuse-minio-data` |
| Mount | `/data` |
| Written by | the replaced upstream image, running as root |
| Contains | Langfuse trace payloads — real production data |

**Validation rules**

- The replacement MUST write to it without a migration step.
- Its on-disk format MUST NOT change — guaranteed by construction, since the version does not move.
- Its ownership MUST be **observed** before the production rollout. Currently inferred from the
  upstream image's published config; that inference is the one unresolved fact in the spec.

**Why it constrains E1**: it is the reason the image runs as root and the reason the version is held
constant. Both are reversible later, separately, each with its own verification.

---

## E4 — Scanner scope rule

The partition deciding which scanner examines which image.

| Attribute | Current | After |
|---|---|---|
| Expression | `ref.includes('jumbleknot/')` | membership of `BUILT_IMAGE_NAMES` |
| Intent (unchanged) | "exclude images cd-deploy already scans" | same |
| Correct? | **No** — states an intent it does not implement | Yes |

**Invariant** (see `contracts/scanner-scope.md`): every image the project publishes or pulls is
examined by exactly one scanner. Neither zero nor two.

**Why the current rule is wrong**: it excludes by *naming convention* what should be excluded by
*coverage*. `jumbleknot/minio` is built by us but not by cd-deploy, so it satisfies the exclusion while
satisfying nothing that justifies it.

---

## E5 — Suppression entries

Recorded acceptances of known findings, keyed to an image reference.

Four exist for the images being replaced:

| Image key | Advisory |
|---|---|
| `minio/mc:RELEASE\.2025-08-13T08-35-41Z` | `CVE-2025-68121` |
| `minio/mc:RELEASE\.2025-08-13T08-35-41Z` | `CVE-2026-33186` |
| `minio/minio:RELEASE\.2025-09-07T16-13-09Z` | `CVE-2025-68121` |
| `minio/minio:RELEASE\.2025-09-07T16-13-09Z` | `CVE-2026-33186` |

**Validation rules**

- All four MUST be deleted. The images they key on leave the pulled set entirely.
- Deletion, not expiry: an entry matching nothing does not age out quietly — it fails under
  `UNMATCHED ENTRIES` and reddens the weekly expiry run.
- **Do not pre-emptively re-key them to the new image.** Whether the from-source build still carries
  `CVE-2025-68121` is an empirical question the first real sweep answers. Writing a suppression before
  observing the finding would suppress something we have not seen — and R3 predicts a newer Go clears
  exactly this one, so guessing risks hiding a success.

---

## E6 — Floating-tag exception set

The declared list of image references whose tags the classifier cannot order.

| | Current | After |
|---|---|---|
| Members | `minio/minio`, `minio/mc` (date-style `RELEASE.*` tags) | **empty** |
| Asserted by | `infra-image-scan.test.mjs` — set equality | same test, new premise |
| Runbook states | *"a floating count of 0 is a FAILURE, not a success"* | must be restated |

**Why this is delicate**: that "0 is a FAILURE" rule exists to stop someone widening the classifier to
make the report read clean. This change empties the set *legitimately* — by removing the images, not by
teaching the classifier to vouch for them. The guard must distinguish those two situations, which means
it must be rewritten to assert the new premise, not deleted because it became inconvenient.
