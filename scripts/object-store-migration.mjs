#!/usr/bin/env node
// Feature 080 (item #560) — move a MinIO drive to RustFS IN PLACE, with evidence at every step.
//
//   node scripts/object-store-migration.mjs <subcommand> [options]
//
// TEMPORARY. This tool exists for the three cutovers of feature 080 (dev Langfuse, prod Langfuse,
// the host-managed Nx cache) and is deleted with its guard exemption in the cleanup PR after the
// rollback window (tasks.md T048). It is the one live file allowed to name MinIO's on-disk
// structures, because reading them is its job (contracts/no-minio-guard.md G2).
//
// WHAT IT DOES, AND WHY A TOOL RATHER THAN A RUNBOOK OF SHELL (plan.md Complexity Tracking): both
// feature-070 traps — `docker run -v <name>:` silently CREATING a mistyped volume, and a top-level
// `stat` mistaken for full ownership — were hit by hand procedures. Each step below closes one:
//
//   inventory  read-only. Mounts a STOPPED drive `:ro` and records the facts that decide whether
//              RustFS can read it (research R6): `xl-single`, exactly one set of one drive, zero
//              SSE objects, zero tiered objects, no bucket notification target. Plus a control
//              count (every xl.meta starts `XL2 `) so a broken grep cannot read as "zero SSE", and a
//              content digest of the whole tree. Refuses (exit 1) on any blocking finding.
//   manifest   read-only. Lists every object (and every version, for a versioned bucket) from the
//              RUNNING old store after writers stop, and SHA-256s every multipart object plus a
//              deterministic sample.
//   copy       the ONLY writing subcommand, and only with --apply. Refuses an existing target or a
//              source still mounted by a running container; copies `:ro` → new volume; chowns the
//              copy to the uid READ FROM THE PINNED IMAGE (never a literal — research R5); counts
//              entries with any other owner (must be 0); re-digests the source (must not change).
//   verify     read-only. Lists the new store and compares with the manifest — key, size, ETag,
//              versions — and re-checksums the same sample. Exit 1 on any discrepancy.
//   rehearse   runs the Docker rehearsal (scripts/__tests__/object-store-migration.rehearsal.mjs)
//              with skipping forbidden. Scratch resources only, all removed afterwards.
//
// DOCKER, AND WHERE THIS RUNS. Docker is driven through the CLI only, so DOCKER_HOST is honoured.
// In production it runs ON THE HOST inside a pinned container (scripts/object-store-migration.sh,
// decided 2026-10-11 in tasks.md T003), never over `DOCKER_HOST=ssh://` from the dev container.
//
// CREDENTIALS. S3 calls run inside `docker run --rm --network <net> <pinned rustfs image> curl
// --aws-sigv4`, with the key pair passed BY NAME (`-e S3_ACCESS_KEY -e S3_SECRET_KEY`) from the
// caller's environment and fed to curl on stdin as a config. The secret's value is never in any
// process's argv — the rule backups/compose.yaml records from commit 56983c75.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ArgvError, dieOnArgvError, partitionArgsWithValues, wantsHelp } from './lib/argv-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** The compose file whose rustfs/rustfs pin is the default `--image` — one source of truth. */
export const PIN_SOURCE = 'infrastructure-as-code/docker/observability/compose.prod.yaml';

export const SUBCOMMANDS = ['inventory', 'manifest', 'copy', 'verify', 'rehearse'];
export const ACCEPTED_FLAGS = ['--apply', '--help', '-h'];
export const VALUE_FLAGS = ['--volume', '--out', '--endpoint', '--network', '--manifest', '--from', '--to', '--image'];

const REQUIRED = {
  inventory: ['--volume', '--out'],
  manifest: ['--endpoint', '--network', '--out'],
  copy: ['--from', '--to', '--out'],
  verify: ['--endpoint', '--network', '--manifest', '--out'],
  rehearse: [],
};
const OPTIONAL = {
  inventory: ['--image'],
  manifest: ['--image'],
  copy: ['--image'],
  verify: ['--image'],
  rehearse: [],
};

export const USAGE = `usage: node scripts/object-store-migration.mjs <subcommand> [options]

Read-only unless stated. Credentials for manifest/verify come from the ENVIRONMENT
(S3_ACCESS_KEY, S3_SECRET_KEY) and are passed to Docker by name, never as values.

  inventory --volume <name> --out <file> [--image <ref>]
      Inspect a STOPPED drive (mounted read-only). Exit 1 if it is not migratable.
  manifest  --endpoint <http://host:9000> --network <docker network> --out <file> [--image <ref>]
      List every object (and version) of the RUNNING old store; checksum the sample.
  copy      --from <volume> --to <new volume> --out <file> --apply [--image <ref>]
      WRITES: create <new volume>, copy <volume> into it, chown to the image's uid.
      Refused without --apply, if <new volume> exists, or if <volume> is in use.
  verify    --endpoint <url> --network <net> --manifest <file> --out <file> [--image <ref>]
      Compare the RUNNING new store with the manifest. Exit 1 on any discrepancy.
  rehearse
      Run the Docker rehearsal (scratch volumes only) with skipping forbidden.

  --image   the RustFS image used for helper containers and for the chown uid.
            Default: the rustfs/rustfs pin in ${PIN_SOURCE}.
  --help, -h  print this text and do nothing else.
`;

/**
 * Turn argv into exactly one action, or refuse. Never guesses, never defaults an action.
 * @returns {{command: string, apply: boolean, options: Record<string, string>}}
 */
export function resolveCommand(argv = []) {
  if (wantsHelp(argv)) return { command: 'help', apply: false, options: {} };
  const { flags, values, positionals } = partitionArgsWithValues(argv, {
    accepted: ACCEPTED_FLAGS,
    withValues: VALUE_FLAGS,
    maxPositionals: 1,
    usage: USAGE,
  });
  const command = positionals[0];
  if (!command) throw new ArgvError(`a subcommand is required: ${SUBCOMMANDS.join(', ')}\n\n${USAGE}`);
  if (!SUBCOMMANDS.includes(command)) {
    throw new ArgvError(`unknown subcommand: ${command}\naccepted: ${SUBCOMMANDS.join(', ')}\n\n${USAGE}`);
  }
  const apply = flags.has('--apply');
  if (command === 'copy' && !apply) {
    throw new ArgvError(
      'copy writes a new volume and is refused without --apply. There is no dry-run spelling: run ' +
        '`inventory` to look without writing.\n\n' + USAGE,
    );
  }
  if (command !== 'copy' && apply) {
    throw new ArgvError(`--apply means nothing to ${command}, which never writes; refusing rather than ignoring it\n\n${USAGE}`);
  }
  const allowed = [...REQUIRED[command], ...OPTIONAL[command]];
  const stray = [...values.keys()].filter((k) => !allowed.includes(k));
  if (stray.length) throw new ArgvError(`${stray.join(', ')} does not apply to ${command}\n\n${USAGE}`);
  const missing = REQUIRED[command].filter((k) => !values.has(k));
  if (missing.length) throw new ArgvError(`${command} requires ${missing.join(', ')}\n\n${USAGE}`);
  const options = Object.fromEntries([...values].map(([k, v]) => [k.slice(2), v]));
  if (command === 'copy' && options.from === options.to) {
    throw new ArgvError('copy --from and --to name the same volume; refusing to copy a volume onto itself');
  }
  return { command, apply, options };
}

// ── pure logic ──────────────────────────────────────────────────────────────────────────────────

/**
 * Decide from measured facts whether RustFS can read this drive (research R6). Every blocking
 * finding is a reason; an absent measurement is a reason too, never an implied zero.
 */
export function classifyDrive(formatJson, counts = {}) {
  const reasons = [];
  let fmt = formatJson;
  if (typeof fmt === 'string') {
    try {
      fmt = JSON.parse(fmt);
    } catch {
      fmt = null;
    }
  }
  const format = fmt && typeof fmt === 'object' ? fmt.format : undefined;
  const sets = fmt?.xl?.sets;
  if (!format) {
    reasons.push('no readable .minio.sys/format.json — not a MinIO drive, or an unreadable one');
  } else if (format !== 'xl-single') {
    reasons.push(`format is "${format}", not "xl-single" — RustFS reads only the single-drive erasure layout (the legacy "fs" layout is unreadable)`);
  }
  if (format) {
    if (!Array.isArray(sets) || sets.length !== 1) {
      reasons.push(`expected exactly one erasure set, found ${Array.isArray(sets) ? sets.length : 'none'}`);
    } else if (!Array.isArray(sets[0]) || sets[0].length !== 1) {
      reasons.push(`expected exactly one drive in the set, found ${Array.isArray(sets[0]) ? sets[0].length : 'none'} — drive count must match`);
    }
  }
  const need = (name, label) => {
    const v = counts[name];
    if (!Number.isInteger(v)) {
      reasons.push(`${label} count was not measured (${name} missing) — an absent measurement is not a zero`);
      return;
    }
    if (v > 0) reasons.push(`${v} ${label} object(s)`);
  };
  need('sseObjects', 'SSE (server-side-encrypted; RustFS fails closed on them)');
  need('tieredObjects', 'tiered/transitioned (not fixture-proven upstream)');
  // The search must find a marker planted AFTER non-UTF-8 bytes, or its zeros mean nothing: BusyBox
  // grep in its default locale misses exactly that case, and a real xl.meta is nothing but that case
  // (measured 2026-10-11: a real SSE-S3 object counted 0 by default, 1 with LC_ALL=C).
  const st = counts.selfTest;
  if (!st || st.sse !== 1 || st.tiered !== 1) {
    reasons.push(`the grep instrument failed its self-test (${st ? `sse ${st.sse}, tiered ${st.tiered}` : 'not run'}; each must be 1) — its SSE/tiered zeros mean nothing`);
  }
  if (Number.isInteger(counts.xlMetaFiles) && Number.isInteger(counts.control) && counts.control !== counts.xlMetaFiles) {
    reasons.push(
      `control count ${counts.control} != xl.meta files ${counts.xlMetaFiles} — the search instrument is broken, so its zeros mean nothing`,
    );
  }
  const notif = counts.notificationBuckets;
  if (!Array.isArray(notif)) {
    reasons.push('bucket notification configuration was not measured');
  } else {
    for (const b of notif) reasons.push(`bucket notification configuration present on "${b}" (no target exists in any stack)`);
  }
  return { verdict: reasons.length ? 'refused' : 'migratable', reasons, format: format ?? null, sets: sets ?? null };
}

/** Parse the line-oriented report INVENTORY_SCRIPT prints. Throws on a missing line. */
export function parseInventoryOutput(text) {
  const lines = String(text).split('\n');
  const one = (tag) => {
    const l = lines.find((x) => x.startsWith(`${tag} `));
    if (l === undefined) throw new Error(`inventory report is missing its ${tag} line — the in-container script did not finish`);
    return l.slice(tag.length + 1).trim();
  };
  const int = (tag) => {
    const v = one(tag);
    if (!/^\d+$/.test(v)) throw new Error(`inventory ${tag} is not a count: ${JSON.stringify(v)}`);
    return Number(v);
  };
  const rawFormat = one('FORMAT');
  let format = null;
  try {
    format = JSON.parse(rawFormat);
  } catch {
    format = null;
  }
  const buckets = lines
    .filter((l) => l.startsWith('BUCKET '))
    .map((l) => {
      const [, name, objects, bytes, meta, versioning, lifecycle, notification] = l.split(' ');
      return {
        name,
        objects: Number(objects),
        bytes: Number(bytes),
        hasMetadataBin: meta === '1',
        versioning: versioning === '1',
        lifecycle: lifecycle === '1',
        notification: notification === '1',
      };
    });
  const [stSse, stTiered] = one('SELFTEST').split(/\s+/).map(Number);
  const digest = one('TREEDIGEST');
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error(`inventory TREEDIGEST is not a sha256: ${digest}`);
  return {
    format,
    selfTest: { sse: stSse, tiered: stTiered },
    xlMetaFiles: int('XLMETA'),
    control: int('CONTROL'),
    sseObjects: int('SSE'),
    tieredObjects: int('TIERED'),
    ownerUid: int('OWNER'),
    iamUsersBeyondRoot: int('IAMUSERS'),
    files: int('FILES'),
    buckets,
    notificationBuckets: buckets.filter((b) => b.notification).map((b) => b.name),
    treeDigest: digest,
  };
}

const unquote = (etag) => String(etag ?? '').replace(/^"+|"+$/g, '').replace(/^&quot;|&quot;$/g, '');
const objKey = (o) => `${o.bucket}\u0000${o.key}`;
const verKey = (o) => `${o.bucket}\u0000${o.key}\u0000${o.versionId ?? ''}`;

function diffSet(oldList, newList, keyOf, after) {
  const out = { missing: [], unexpected: [], sizeMismatch: [], etagMismatch: [], writtenAfterManifest: [] };
  const oldMap = new Map(oldList.map((o) => [keyOf(o), o]));
  const newMap = new Map(newList.map((o) => [keyOf(o), o]));
  for (const [k, o] of oldMap) {
    const n = newMap.get(k);
    if (!n) {
      out.missing.push(o);
      continue;
    }
    if (Number(o.size) !== Number(n.size)) out.sizeMismatch.push({ ...o, newSize: n.size });
    if (unquote(o.etag) !== unquote(n.etag)) out.etagMismatch.push({ ...o, newEtag: n.etag });
    if (Boolean(o.deleteMarker) !== Boolean(n.deleteMarker)) out.etagMismatch.push({ ...o, newDeleteMarker: Boolean(n.deleteMarker) });
  }
  for (const [k, n] of newMap) {
    if (oldMap.has(k)) continue;
    if (after && n.lastModified && Date.parse(n.lastModified) > Date.parse(after)) out.writtenAfterManifest.push(n);
    else out.unexpected.push(n);
  }
  return out;
}

/**
 * Compare two manifests. Objects are keyed by bucket+key; versions (when present) by
 * bucket+key+versionId. An object the old store never had is `unexpected` unless its lastModified
 * is after the old manifest was taken, in which case it was written after cutover and is reported
 * separately rather than failed.
 */
export function diffManifests(oldM, newM) {
  const after = oldM?.takenAt;
  const a = diffSet(oldM?.objects ?? [], newM?.objects ?? [], objKey, after);
  if (Array.isArray(oldM?.versions) || Array.isArray(newM?.versions)) {
    const b = diffSet(oldM?.versions ?? [], newM?.versions ?? [], verKey, after);
    for (const k of Object.keys(a)) a[k].push(...b[k]);
  }
  return a;
}

const totals = (objects = []) => ({
  objects: objects.length,
  bytes: objects.reduce((s, o) => s + Number(o.size || 0), 0),
});

/** The parity report (data-model.md). `checksumMismatch` comes from re-reading the sample. */
export function parityReport(oldM, newM, checksumMismatch = []) {
  const d = diffManifests(oldM, newM);
  const failed =
    d.missing.length + d.unexpected.length + d.sizeMismatch.length + d.etagMismatch.length + checksumMismatch.length > 0;
  return {
    ...d,
    checksumMismatch,
    totals: { old: totals(oldM?.objects), new: totals(newM?.objects) },
    verdict: failed ? 'fail' : 'pass',
  };
}

/**
 * The objects to SHA-256 on both sides: every multipart object (ETag contains `-`, so the ETag is
 * not a content MD5 and proves nothing about the bytes), plus the first 50 by SHA-256 of
 * `bucket/key` — or every object when there are fewer than 200. Order-independent by construction.
 */
export function checksumSample(objects = []) {
  const live = objects.filter((o) => !o.deleteMarker);
  const id = (o) => `${o.bucket}/${o.key}`;
  const h = (o) => createHash('sha256').update(id(o)).digest('hex');
  const ranked = [...live].sort((x, y) => (h(x) < h(y) ? -1 : h(x) > h(y) ? 1 : 0));
  const picked = live.length < 200 ? ranked : ranked.slice(0, 50);
  const chosen = new Map(picked.map((o) => [id(o), o]));
  for (const o of live) if (String(o.etag).includes('-')) chosen.set(id(o), o);
  return [...chosen.values()]
    .sort((x, y) => (id(x) < id(y) ? -1 : id(x) > id(y) ? 1 : 0))
    .map((o) => ({ bucket: o.bucket, key: o.key }));
}

// ── S3 XML ──────────────────────────────────────────────────────────────────────────────────────

const xmlDecode = (s) =>
  String(s)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
const tag = (xml, name) => {
  const m = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? xmlDecode(m[1]) : undefined;
};
const blocks = (xml, name) => [...String(xml).matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);

function assertListing(xml, root) {
  if (!new RegExp(`<${root}[\\s>]`).test(String(xml))) {
    const code = tag(xml, 'Code');
    throw new Error(`S3 response is not a listing (${root})${code ? `: ${code} — ${tag(xml, 'Message') ?? ''}` : ''}`);
  }
}

export function parseListBuckets(xml) {
  assertListing(xml, 'ListAllMyBucketsResult');
  return blocks(xml, 'Bucket').map((b) => tag(b, 'Name'));
}

export function parseListObjects(xml, bucket) {
  assertListing(xml, 'ListBucketResult');
  return {
    truncated: tag(xml, 'IsTruncated') === 'true',
    nextToken: tag(xml, 'NextContinuationToken'),
    objects: blocks(xml, 'Contents').map((c) => ({
      bucket,
      key: tag(c, 'Key'),
      size: Number(tag(c, 'Size')),
      etag: tag(c, 'ETag'),
      lastModified: tag(c, 'LastModified'),
    })),
  };
}

export function parseListVersions(xml, bucket) {
  assertListing(xml, 'ListVersionsResult');
  const versions = [];
  // Versions and delete markers interleave in key order; keep each block's kind.
  for (const m of String(xml).matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
    const b = m[2];
    const v = {
      bucket,
      key: tag(b, 'Key'),
      versionId: tag(b, 'VersionId'),
      isLatest: tag(b, 'IsLatest') === 'true',
      size: Number(tag(b, 'Size') ?? 0),
      etag: tag(b, 'ETag') ?? '',
      lastModified: tag(b, 'LastModified'),
    };
    if (m[1] === 'DeleteMarker') v.deleteMarker = true;
    versions.push(v);
  }
  return {
    truncated: tag(xml, 'IsTruncated') === 'true',
    nextKeyMarker: tag(xml, 'NextKeyMarker'),
    nextVersionIdMarker: tag(xml, 'NextVersionIdMarker'),
    versions,
  };
}

/** Path-style S3 path: each key segment percent-encoded (RFC 3986 unreserved kept), slashes kept. */
export function s3Path(bucket, key) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (key === undefined) return `/${enc(bucket)}`;
  return `/${enc(bucket)}/${String(key).split('/').map(enc).join('/')}`;
}

/** The single digest-pinned rustfs/rustfs ref in a compose file. */
export function pinnedRustfsRef(composeText) {
  const refs = [...String(composeText).matchAll(/rustfs\/rustfs:[^\s"'@]+(?:@sha256:[0-9a-f]+)?/g)].map((m) => m[0]);
  const unique = [...new Set(refs)];
  if (unique.length === 0) throw new Error('no rustfs/rustfs image reference found');
  if (unique.length > 1) throw new Error(`more than one rustfs/rustfs reference: ${unique.join(', ')}`);
  if (!/@sha256:[0-9a-f]{64}$/.test(unique[0])) throw new Error(`rustfs/rustfs reference is not digest-pinned: ${unique[0]}`);
  return unique[0];
}

// ── Docker ──────────────────────────────────────────────────────────────────────────────────────

const SIGV4 = 'aws:amz:us-east-1:s3';

function docker(args, { input, allowFail = false } = {}) {
  const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.error) throw new Error(`docker ${args[0]}: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${args.slice(0, 2).join(' ')} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r;
}

export function volumeExists(name) {
  return docker(['volume', 'inspect', name], { allowFail: true }).status === 0;
}

function containersUsing(volume) {
  return docker(['ps', '-q', '--filter', `volume=${volume}`]).stdout.split('\n').filter(Boolean);
}

/** The runtime uid/gid of an image — read from the image, never written as a literal (R5). */
export function imageIdentity(image) {
  const r = docker(['run', '--rm', '--entrypoint', 'id', image]);
  const uid = r.stdout.match(/uid=(\d+)/);
  const gid = r.stdout.match(/gid=(\d+)/);
  if (!uid || !gid) throw new Error(`cannot read the runtime identity of ${image}: ${r.stdout.trim()}`);
  return { uid: Number(uid[1]), gid: Number(gid[1]) };
}

function defaultImage() {
  const p = resolve(REPO_ROOT, PIN_SOURCE);
  if (!existsSync(p)) throw new Error(`--image not given and ${PIN_SOURCE} is not present to read the pin from`);
  return pinnedRustfsRef(readFileSync(p, 'utf8'));
}

// The in-container inventory. BusyBox `find`/`grep` (no `grep --include` — T003's first attempt).
// It prints one tagged line per fact; parseInventoryOutput refuses a report with a line missing.
//
// LC_ALL=C IS LOAD-BEARING. In its default locale BusyBox grep does not match a pattern that follows
// non-UTF-8 bytes on the same "line" — and an xl.meta is msgpack, so every marker in it does.
// Measured 2026-10-11 on the deployed MinIO with one real SSE-S3 object: default locale → 0,
// LC_ALL=C → 1, while the `XL2 ` control said 6 of 6 either way (that header precedes every high
// byte, so it cannot see the fault). Hence SELFTEST: the same count() over a planted xl.meta whose
// markers sit AFTER high bytes must find each one, or classifyDrive refuses.
export const INVENTORY_SCRIPT = String.raw`
set -eu
export LC_ALL=C
count() { find "$1" -name xl.meta -type f -exec grep -lis "$2" {} + | wc -l; }
mkdir -p /tmp/selftest/obj
printf 'XL2 \001\000\377\376\201\302 X-Minio-Internal-Server-Side-Encryption-Sealed-Key \377\000 transition-status \376' > /tmp/selftest/obj/xl.meta
echo "SELFTEST $(count /tmp/selftest X-Minio-Internal-Server-Side-Encryption) $(count /tmp/selftest transition-status)"
cd /data
f=.minio.sys/format.json
if [ -f "$f" ]; then printf 'FORMAT %s\n' "$(tr -d '\n' < "$f")"; else echo 'FORMAT null'; fi
echo "XLMETA $(find . -name xl.meta -type f | wc -l)"
echo "CONTROL $(count . 'XL2 ')"
echo "SSE $(count . X-Minio-Internal-Server-Side-Encryption)"
echo "TIERED $(count . transition-status)"
echo "OWNER $(stat -c %u /data)"
echo "IAMUSERS $(ls .minio.sys/config/iam/users 2>/dev/null | wc -l)"
for b in $(ls -A /data); do
  [ "$b" = .minio.sys ] && continue
  [ "$b" = .rustfs.sys ] && continue
  [ -d "$b" ] || continue
  n=$(find "$b" -name xl.meta -type f | wc -l)
  bytes=$(find "$b" -type f -exec stat -c %s {} + | awk '{s+=$1} END {printf "%d", s}')
  # xl-single keeps bucket metadata as an object: .metadata.bin/xl.meta (measured on the deployed
  # image). A plain .metadata.bin file is the older layout; read whichever exists.
  m=.minio.sys/buckets/$b/.metadata.bin
  [ -d "$m" ] && m=$m/xl.meta
  meta=0; ver=0; lc=0; nt=0
  if [ -f "$m" ]; then
    meta=1
    # Anchored on the element: a lifecycle Rule carries <Status>Enabled</Status> too.
    grep -qsE '<VersioningConfiguration[^>]*><Status>(Enabled|Suspended)</Status>' "$m" && ver=1 || true
    grep -qs '<LifecycleConfiguration' "$m" && grep -qs '<Rule>' "$m" && lc=1 || true
    grep -qsE '<(QueueConfiguration|TopicConfiguration|CloudFunctionConfiguration)>' "$m" && nt=1 || true
  fi
  echo "BUCKET $b $n $bytes $meta $ver $lc $nt"
done
echo "FILES $(find . -type f | wc -l)"
digest=$( { find . -type d | LC_ALL=C sort; find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum; } | sha256sum | cut -d' ' -f1)
echo "TREEDIGEST $digest"
`;

function inventoryOf(volume, image) {
  if (!volumeExists(volume)) {
    // `docker run -v <name>:` would CREATE it, silently, and report an empty drive (feature 070 trap 1).
    throw new Error(`volume ${volume} does not exist — refusing to mount it, which would create it empty`);
  }
  const r = docker(['run', '--rm', '-i', '--user', '0:0', '--network', 'none', '-v', `${volume}:/data:ro`,
    '--entrypoint', 'sh', image, '-s'], { input: INVENTORY_SCRIPT, allowFail: true });
  if (r.status !== 0) throw new Error(`inventory script failed (exit ${r.status}): ${r.stderr.trim()}`);
  return parseInventoryOutput(r.stdout);
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  console.error(`wrote ${path}`);
}

export function cmdInventory({ volume, out, image }) {
  const inv = inventoryOf(volume, image);
  const inUse = containersUsing(volume);
  const c = classifyDrive(inv.format, inv);
  const record = {
    volume,
    takenAt: new Date().toISOString(),
    image,
    format: c.format,
    sets: c.sets,
    xlMetaFiles: inv.xlMetaFiles,
    control: inv.control,
    sseObjects: inv.sseObjects,
    tieredObjects: inv.tieredObjects,
    buckets: inv.buckets,
    iamUsersBeyondRoot: inv.iamUsersBeyondRoot,
    ownerUid: inv.ownerUid,
    files: inv.files,
    treeDigest: inv.treeDigest,
    // The digest is only a rollback reference when nothing can write: M0.4 runs this against a
    // live drive as a go/no-go, and says so here rather than leaving a moving digest unexplained.
    sourceInUse: inUse.length > 0,
    verdict: c.verdict,
    reasons: c.reasons,
  };
  writeJson(out, record);
  console.log(`inventory ${volume}: ${c.verdict}${c.reasons.length ? `\n  - ${c.reasons.join('\n  - ')}` : ''}`);
  return record;
}

// ── S3 through a throwaway container ─────────────────────────────────────────────────────────────

function requireCreds() {
  const missing = ['S3_ACCESS_KEY', 'S3_SECRET_KEY'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`${missing.join(' and ')} must be set in the environment (never passed as arguments)`);
}

const S3_GET_SCRIPT = String.raw`
set -eu
printf 'user = "%s:%s"\n' "$S3_ACCESS_KEY" "$S3_SECRET_KEY" > /tmp/k
code=$(curl -sS -K /tmp/k --aws-sigv4 "$SIGV4" -o /tmp/body -w '%{http_code}' "$REQ_URL") || { echo "HTTP_STATUS:000"; exit 0; }
cat /tmp/body
printf '\nHTTP_STATUS:%s\n' "$code"
`;

function s3Get(ctx, pathAndQuery) {
  const url = `${ctx.endpoint.replace(/\/+$/, '')}${pathAndQuery}`;
  const r = docker(['run', '--rm', '--network', ctx.network, '-e', 'S3_ACCESS_KEY', '-e', 'S3_SECRET_KEY',
    '-e', `SIGV4=${SIGV4}`, '-e', `REQ_URL=${url}`, '--entrypoint', 'sh', ctx.image, '-c', S3_GET_SCRIPT]);
  const m = r.stdout.match(/\nHTTP_STATUS:(\d{3})\n?$/);
  if (!m) throw new Error(`no status from S3 GET ${pathAndQuery}: ${r.stdout.slice(-300)} ${r.stderr}`);
  const body = r.stdout.slice(0, m.index);
  if (m[1] !== '200') throw new Error(`S3 GET ${pathAndQuery} → HTTP ${m[1]}: ${tag(body, 'Code') ?? body.slice(0, 300)}`);
  return body;
}

// SHA-256 of each listed object, in ONE container: paths on stdin, `<sha256|ERROR> <path>` out.
const S3_SUM_SCRIPT = String.raw`
set -u
printf 'user = "%s:%s"\n' "$S3_ACCESS_KEY" "$S3_SECRET_KEY" > /tmp/k
while IFS= read -r p; do
  if curl -fsS -K /tmp/k --aws-sigv4 "$SIGV4" -o /tmp/obj "$BASE$p" 2>/tmp/err; then
    printf '%s %s\n' "$(sha256sum /tmp/obj | cut -d' ' -f1)" "$p"
  else
    printf 'ERROR %s\n' "$p"
  fi
  rm -f /tmp/obj
done
`;

function s3Checksums(ctx, sample) {
  if (sample.length === 0) return [];
  const paths = sample.map((o) => s3Path(o.bucket, o.key));
  const r = docker(['run', '--rm', '-i', '--network', ctx.network, '-e', 'S3_ACCESS_KEY', '-e', 'S3_SECRET_KEY',
    '-e', `SIGV4=${SIGV4}`, '-e', `BASE=${ctx.endpoint.replace(/\/+$/, '')}`, '--entrypoint', 'sh', ctx.image, '-c',
    S3_SUM_SCRIPT], { input: `${paths.join('\n')}\n` });
  const byPath = new Map(
    r.stdout.split('\n').filter(Boolean).map((l) => {
      const i = l.indexOf(' ');
      return [l.slice(i + 1), l.slice(0, i)];
    }),
  );
  return sample.map((o, i) => ({ bucket: o.bucket, key: o.key, sha256: byPath.get(paths[i]) ?? 'ERROR' }));
}

/** List everything the store at ctx serves: objects, and versions of any versioned bucket. */
export function listStore(ctx) {
  const buckets = parseListBuckets(s3Get(ctx, '/'));
  const objects = [];
  const versions = [];
  const versionedBuckets = [];
  for (const bucket of buckets) {
    let token;
    do {
      const q = `?list-type=2&max-keys=1000${token ? `&continuation-token=${encodeURIComponent(token)}` : ''}`;
      const page = parseListObjects(s3Get(ctx, `${s3Path(bucket)}${q}`), bucket);
      objects.push(...page.objects);
      token = page.truncated ? page.nextToken : undefined;
      if (page.truncated && !token) throw new Error(`listing of ${bucket} is truncated without a continuation token`);
    } while (token);
    const vs = tag(s3Get(ctx, `${s3Path(bucket)}?versioning`), 'Status');
    if (vs === 'Enabled' || vs === 'Suspended') {
      versionedBuckets.push(bucket);
      let km;
      let vm;
      do {
        const q = `?versions&max-keys=1000${km ? `&key-marker=${encodeURIComponent(km)}` : ''}${vm ? `&version-id-marker=${encodeURIComponent(vm)}` : ''}`;
        const page = parseListVersions(s3Get(ctx, `${s3Path(bucket)}${q}`), bucket);
        versions.push(...page.versions);
        km = page.truncated ? page.nextKeyMarker : undefined;
        vm = page.truncated ? page.nextVersionIdMarker : undefined;
        if (page.truncated && !km) throw new Error(`version listing of ${bucket} is truncated without a marker`);
      } while (km);
    }
  }
  return { buckets, objects, versions, versionedBuckets };
}

export function cmdManifest({ endpoint, network, out, image }) {
  requireCreds();
  const ctx = { endpoint, network, image };
  const takenAt = new Date().toISOString();
  const listing = listStore(ctx);
  const checksums = s3Checksums(ctx, checksumSample(listing.objects));
  const failed = checksums.filter((c) => c.sha256 === 'ERROR');
  const record = { endpoint, takenAt, ...listing, totals: totals(listing.objects), checksums };
  writeJson(out, record);
  if (failed.length) {
    console.error(`manifest: ${failed.length} sampled object(s) could not be read: ${failed.slice(0, 5).map((c) => `${c.bucket}/${c.key}`).join(', ')}`);
    process.exitCode = 1;
    return record;
  }
  console.log(`manifest ${endpoint}: ${record.totals.objects} objects, ${record.totals.bytes} bytes, ` +
    `${listing.versions.length} versions in ${listing.versionedBuckets.length} versioned bucket(s), ${checksums.length} checksummed`);
  return record;
}

export function cmdVerify({ endpoint, network, manifest, out, image }) {
  requireCreds();
  const old = JSON.parse(readFileSync(manifest, 'utf8'));
  const ctx = { endpoint, network, image };
  const listing = listStore(ctx);
  const sample = (old.checksums ?? []).map(({ bucket, key }) => ({ bucket, key }));
  const now = s3Checksums(ctx, sample);
  const oldSum = new Map((old.checksums ?? []).map((c) => [`${c.bucket}/${c.key}`, c.sha256]));
  const checksumMismatch = now
    .filter((c) => oldSum.get(`${c.bucket}/${c.key}`) !== c.sha256)
    .map((c) => ({ bucket: c.bucket, key: c.key, old: oldSum.get(`${c.bucket}/${c.key}`), new: c.sha256 }));
  const report = parityReport(old, listing, checksumMismatch);
  const record = { endpoint, manifest, verifiedAt: new Date().toISOString(), checksummed: now.length, ...report };
  writeJson(out, record);
  const n = (k) => record[k].length;
  console.log(`verify ${endpoint}: ${record.verdict} — objects ${record.totals.old.objects} → ${record.totals.new.objects}, ` +
    `missing ${n('missing')}, unexpected ${n('unexpected')}, size ${n('sizeMismatch')}, etag ${n('etagMismatch')}, ` +
    `checksum ${n('checksumMismatch')} of ${now.length}, written after manifest ${n('writtenAfterManifest')}`);
  if (record.verdict !== 'pass') process.exitCode = 1;
  return record;
}

// The copy. Runs as root ONLY in this one-shot (a fresh volume is root-owned, and the source may be
// owned by any uid), reads the source `:ro`, and leaves every entry owned by the image's runtime uid.
const COPY_SCRIPT = String.raw`
set -eu
cp -a /src/. /dst/
chown -R "$RUNTIME_UID:$RUNTIME_GID" /dst
echo "NOTOWNED $(find /dst \( ! -user "$RUNTIME_UID" -o ! -group "$RUNTIME_GID" \) | wc -l)"
`;

export function cmdCopy({ from, to, out, image }) {
  if (!volumeExists(from)) throw new Error(`source volume ${from} does not exist`);
  if (volumeExists(to)) {
    const record = { from, to, image, targetPreexisted: true, verdict: 'refused',
      reasons: [`target volume ${to} already exists — refusing to write into it (remove it deliberately, or choose another name)`] };
    writeJson(out, record);
    console.log(`copy refused: ${record.reasons[0]}`);
    process.exitCode = 1;
    return record;
  }
  const inUse = containersUsing(from);
  if (inUse.length) {
    const record = { from, to, image, targetPreexisted: false, verdict: 'refused',
      reasons: [`source volume ${from} is mounted by running container(s) ${inUse.join(', ')} — stop the store first (M3)`] };
    writeJson(out, record);
    console.log(`copy refused: ${record.reasons[0]}`);
    process.exitCode = 1;
    return record;
  }
  const { uid, gid } = imageIdentity(image);
  const before = inventoryOf(from, image);
  docker(['volume', 'create', '--label', 'mcm.object-store-migration.from=' + from, to]);
  const r = docker(['run', '--rm', '-i', '--user', '0:0', '--network', 'none', '-e', `RUNTIME_UID=${uid}`, '-e', `RUNTIME_GID=${gid}`,
    '-v', `${from}:/src:ro`, '-v', `${to}:/dst`, '--entrypoint', 'sh', image, '-s'], { input: COPY_SCRIPT, allowFail: true });
  const m = r.stdout.match(/NOTOWNED (\d+)/);
  const after = inventoryOf(from, image);
  const record = {
    from,
    to,
    image,
    runtimeUid: uid,
    runtimeGid: gid,
    targetPreexisted: false,
    copyExit: r.status,
    entriesNotOwnedByRuntimeUid: m ? Number(m[1]) : null,
    sourceDigestBefore: before.treeDigest,
    sourceDigestAfter: after.treeDigest,
    copiedAt: new Date().toISOString(),
  };
  const reasons = [];
  if (r.status !== 0) reasons.push(`copy container exited ${r.status}: ${r.stderr.trim().slice(0, 500)}`);
  if (record.entriesNotOwnedByRuntimeUid !== 0) reasons.push(`${record.entriesNotOwnedByRuntimeUid ?? 'unknown'} entries not owned by ${uid}:${gid}`);
  if (record.sourceDigestBefore !== record.sourceDigestAfter) reasons.push('the SOURCE changed during the copy — it is no longer a valid rollback target; investigate before anything else');
  record.verdict = reasons.length ? 'fail' : 'pass';
  record.reasons = reasons;
  writeJson(out, record);
  console.log(`copy ${from} → ${to}: ${record.verdict} (uid ${uid}, not owned ${record.entriesNotOwnedByRuntimeUid}, source digest ${record.sourceDigestBefore === record.sourceDigestAfter ? 'unchanged' : 'CHANGED'})`);
  if (reasons.length) {
    console.log(`  - ${reasons.join('\n  - ')}\n  The new volume ${to} is left in place for diagnosis; it is not used by anything yet.`);
    process.exitCode = 1;
  }
  return record;
}

function cmdRehearse() {
  const r = spawnSync(process.execPath, ['--test', resolve(HERE, '__tests__/object-store-migration.rehearsal.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, MCM_REQUIRE_LIVE_STACK: '1' },
  });
  process.exitCode = r.status ?? 1;
}

export function main(argv = process.argv.slice(2)) {
  let cmd;
  try {
    cmd = resolveCommand(argv);
  } catch (err) {
    dieOnArgvError(err, { hard: false });
    return;
  }
  if (cmd.command === 'help') {
    console.log(USAGE);
    return;
  }
  const o = { ...cmd.options };
  if (cmd.command !== 'rehearse' && !o.image) o.image = defaultImage();
  try {
    if (cmd.command === 'inventory') {
      const rec = cmdInventory(o);
      if (rec.verdict !== 'migratable') process.exitCode = 1;
    } else if (cmd.command === 'manifest') cmdManifest(o);
    else if (cmd.command === 'copy') cmdCopy(o);
    else if (cmd.command === 'verify') cmdVerify(o);
    else if (cmd.command === 'rehearse') cmdRehearse();
  } catch (err) {
    console.error(`object-store-migration ${cmd.command}: ${err.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
