// Shared types for per-user scheduled collection backups (feature 073).
// See specs/073-scheduled-backups/data-model.md.
//
// The destination shapes are DISCRIMINATED on `type`, not a single wide interface with every
// field optional. An `s3` document cannot then carry a `username`, and the compiler — not a
// reviewer — is what enforces it. The same union is re-expressed as a `zod` discriminated union
// at the route boundary, where the input is untrusted.

// ─── Destinations ──────────────────────────────────────────────────────────────

export type BackupDestinationType = 's3' | 'webdav';

// Normalised probe outcome. Never carries an upstream response body: that body may contain the
// credential that was just rejected, or a signed URL, and this value is returned to the client
// and persisted on the destination document.
export type BackupTestResult = { ok: true } | { ok: false; reason: string };

interface BackupDestinationCommon {
  _id: string;
  // Keycloak subject. ALWAYS taken from the validated session, never from request input.
  userId: string;
  label: string;
  // Base URL. Re-validated by the resolving URL guard at EVERY use, not only on save — a
  // hostname that was safe when saved can resolve elsewhere by the time it is written to.
  endpoint: string;
  // Key/path prefix beneath which this user's artifacts live.
  basePath: string;
  // AES-256-GCM blob. AAD is `${userId}:backupDestinationSecret:${_id}` — bound to the owner AND
  // the destination, so two of one user's own secrets are not interchangeable.
  secretEnc?: string;
  lastTestedAt?: string;
  lastTestResult?: BackupTestResult;
  createdAt: string;
  updatedAt: string;
}

export interface S3BackupDestination extends BackupDestinationCommon {
  type: 's3';
  bucket: string;
  // MinIO ignores the region, but SigV4's string-to-sign requires one, so it is not optional.
  region: string;
  // Path-style addressing (`host/bucket/key`) rather than virtual-host style. Defaults TRUE:
  // MinIO and most self-hosted stores need it, and a bucket name with a dot breaks virtual-host
  // style under TLS anyway.
  pathStyle: boolean;
  // Not a secret — the S3 access key id is the public half of the pair. Stored in the clear.
  accessKeyId: string;
}

export interface WebdavBackupDestination extends BackupDestinationCommon {
  type: 'webdav';
  // Not a secret. The app password that goes with it is `secretEnc`.
  username: string;
}

export type BackupDestination = S3BackupDestination | WebdavBackupDestination;

// What a route may return. `secretEnc` is excluded by the STORE's read projection rather than
// stripped per route, so a handler that forgets cannot leak it; this type is the compile-time
// half of that same guarantee.
export type BackupDestinationView = Omit<BackupDestination, 'secretEnc' | 'userId' | '_id'> & {
  id: string;
};

// ─── Schedules ─────────────────────────────────────────────────────────────────

export type BackupFrequency = 'daily' | 'weekly' | 'monthly';

export interface Schedule {
  frequency: BackupFrequency;
  // Local to `timeZone`, not to UTC and not to the requesting device.
  hour: number;
  minute: number;
  // ISO weekday, Monday = 1. `weekly` only.
  weekday?: number;
  // `monthly` only. CLAMPS to the month's last day rather than skipping the month — a job set
  // for the 31st must still run in February.
  dayOfMonth?: number;
  // IANA zone name, validated against the runtime's zone list. A property of the JOB: a user who
  // travels does not silently move their backup window.
  timeZone: string;
}

// ─── Jobs and runs ─────────────────────────────────────────────────────────────

export type BackupRunStatus = 'running' | 'success' | 'failed' | 'partial';
export type BackupTrigger = 'manual' | 'scheduled';

// Per-collection tally on a RUN RECORD, keyed by `collectionId`.
export interface BackupCollectionCount {
  collectionId: string;
  name: string;
  movieCount: number;
}

// Per-collection tally inside the ARTIFACT MANIFEST, keyed by `id`.
//
// Deliberately a separate type from BackupCollectionCount despite the identical shape. The
// manifest is a PUBLISHED contract (backup-artifact-v1.schema.json) that names the field `id`,
// while a run record is internal and names it `collectionId`. Collapsing them would mean either
// renaming a field in a contract other people's tooling reads, or carrying both names on one
// object — which is what the first draft did, with casts to make it compile.
export interface ManifestCollectionCount {
  id: string;
  name: string;
  movieCount: number;
}

// Denormalised copy of the newest run, held on the job so the list view is ONE query.
export interface RunSummary {
  runId: string;
  status: BackupRunStatus;
  startedAt: string;
  finishedAt?: string;
  collectionCount: number;
  movieCount: number;
  artifactBytes?: number;
  // The per-collection breakdown US6-AC1 asks to be shown. Optional because the copy
  // denormalised onto the job keeps only the totals — the list view does not need it, and
  // carrying it there would grow a document read on every page load.
  collectionCounts?: BackupCollectionCount[];
  failureReason?: string;
  // Deliberately separate from `failureReason`: a prune that fails has not cost the user the
  // backup that was just written, and reporting the run as failed would say it did.
  pruneFailureReason?: string;
}

export interface BackupJob {
  _id: string;
  userId: string;
  destinationId: string;
  label: string;
  // EMPTY means every collection the user owns AT RUN TIME — resolved then, not at save time,
  // so a collection created after the job was saved is still backed up.
  collectionIds: string[];
  // Absent means on-demand only.
  schedule?: Schedule;
  keepLast: number;
  enabled: boolean;
  // Recomputed on save and after every run. The tick's only query.
  nextRunAt?: string;
  // Non-null means a run is in flight. Reclaimable once older than the run-timeout ceiling,
  // which is what stops an instance killed mid-run wedging its job for ever.
  claimedAt?: string | null;
  lastRun?: RunSummary;
  createdAt: string;
  updatedAt: string;
}

export interface BackupRun {
  _id: string;
  userId: string;
  jobId: string;
  trigger: BackupTrigger;
  status: BackupRunStatus;
  startedAt: string;
  finishedAt?: string;
  // Set ONLY on success. An unset key is precisely why a failed run can never later be listed
  // as a restorable version.
  artifactKey?: string;
  artifactBytes?: number;
  collectionCounts: BackupCollectionCount[];
  failureReason?: string;
  prunedCount?: number;
  pruneFailureReason?: string;
  // A real BSON Date, and the ONLY Date in this feature — everything else is an ISO string.
  // MongoDB's TTL monitor reads Date fields and silently ignores string ones, so a TTL index
  // over `startedAt` would exist, appear in `getIndexes()`, and expire nothing at all.
  expiresAt: Date;
}

// ─── The artifact ──────────────────────────────────────────────────────────────

export const BACKUP_FORMAT_VERSION = 1;

export interface BackupManifest {
  // An integer. Restore REFUSES anything it does not recognise rather than best-effort parsing
  // a body whose meaning it is guessing at.
  formatVersion: number;
  createdAt: string;
  jobId: string;
  collections: ManifestCollectionCount[];
  totalMovieCount: number;
  // Hex sha256 over the canonically serialised, UNCOMPRESSED `collections` array — not over the
  // compressed bytes, so the check survives a change of compression level and still catches a
  // bad decompression.
  sha256: string;
}

export interface BackupArtifactCollection {
  id: string;
  name: string;
  description?: string;
  movies: unknown[];
}

export interface BackupArtifact {
  manifest: BackupManifest;
  collections: BackupArtifactCollection[];
}

// One artifact present at a destination.
export interface BackupVersion {
  key: string;
  createdAt: string;
  sizeBytes: number;
  // False for a zero-length or unreadable object. Such a version is LISTED — it is really there
  // and hiding it would be a lie about the destination — but never offered for restore.
  usable: boolean;
}

// ─── Driver results ────────────────────────────────────────────────────────────

// One object as the destination reports it. Deliberately not S3-shaped: no ETag, no storage
// class, nothing a WebDAV server cannot answer.
export interface BackupObjectInfo {
  key: string;
  sizeBytes: number;
  lastModified: string;
}

// Why a probe failed, at the granularity the user needs to act: an unreachable host is a
// different fix from a rejected credential, which is a different fix again from a credential
// that authenticates but may not write.
export type BackupProbeFailure =
  | 'unreachable'
  | 'credentials-rejected'
  | 'no-write-permission'
  | 'address-not-allowed';

export interface BackupProbeOutcome {
  ok: boolean;
  failure?: BackupProbeFailure;
  reason?: string;
}
