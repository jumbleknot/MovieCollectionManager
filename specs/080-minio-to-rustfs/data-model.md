# Data Model: Replace MinIO with RustFS

No application data model changes. These are the records the migration tool
(`scripts/object-store-migration.mjs`) writes as JSON evidence; each is attached to the PR or the
cutover record.

## Inventory (`inventory.json`)

| Field | Type | Rule |
|---|---|---|
| `volume` | string | The Docker volume name inspected. |
| `format` | string | From `.minio.sys/format.json` `.format`. **Must be `xl-single`**; `fs` or anything else → refuse. |
| `sets` | number[][] shape | From `.xl.sets`. **Must be exactly one set of one drive.** |
| `sseObjects` | number | `xl.meta` files containing `X-Minio-Internal-Server-Side-Encryption` (case-insensitive). **Must be 0.** |
| `tieredObjects` | number | `xl.meta` files containing `transition-status`. **Must be 0.** |
| `buckets[]` | `{name, objects, bytes, hasMetadataBin, versioning, lifecycle, notification}` | Recorded; `notification` present → refuse (no target exists in any stack). |
| `iamUsersBeyondRoot` | number | Entries under `.minio.sys/config/iam/users/`. Recorded (expected 0). |
| `ownerUid` | number | Owner of `/data`. Recorded. |
| `treeDigest` | string | SHA-256 over the sorted `(path, size, sha256)` list of every file. |
| `verdict` | `"migratable"` \| `"refused"` | With `reasons[]` when refused. |

## Manifest (`manifest.json`)

Taken from the **running** old store after writers stop.

| Field | Type |
|---|---|
| `endpoint`, `takenAt` | string |
| `objects[]` | `{bucket, key, size, etag}` — every object, every bucket |
| `totals` | `{objects, bytes}` |
| `checksums[]` | `{bucket, key, sha256}` — every multipart object (ETag contains `-`) plus a deterministic sample: the first 50 keys by SHA-256 of `bucket/key`, or all objects if fewer than 200 |

## Copy record (`copy.json`)

| Field | Rule |
|---|---|
| `from`, `to`, `image`, `runtimeUid` | `runtimeUid` read from `image`, never a literal |
| `targetPreexisted` | Must be `false` (refuse otherwise) |
| `entriesNotOwnedByRuntimeUid` | Must be `0` |
| `sourceDigestBefore`, `sourceDigestAfter` | Must be equal to each other and to `inventory.treeDigest` |

## Parity report (`parity.json`)

| Field | Rule |
|---|---|
| `missing[]`, `unexpected[]`, `sizeMismatch[]`, `etagMismatch[]`, `checksumMismatch[]` | All must be empty for `pass` |
| `totals.old`, `totals.new` | Equal (new may exceed old only by objects written after cutover, listed in `unexpected[]` with `lastModified` after cutover — reported, not failed, when verify runs after writers resume) |
| `verdict` | `"pass"` \| `"fail"` |

## State transitions (production drive)

```
MinIO serving (writers on)
  → writers stopped (M1) → manifest taken (M2) → MinIO stopped (M3)
  → inventory: migratable → copied to new volume (original untouched)
  → RustFS serving new volume (M4) → verify pass (M5) → rollback window
  → original deleted (M7)
any failure before M7 → rollback (M6): MinIO serving original volume
```
