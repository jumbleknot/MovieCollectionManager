#!/usr/bin/env node
// cd-deploy prod-apk — publish the release APK to the forge's GENERIC package registry (item #161).
//
// Why this exists: `prod-apk` ended at `actions/upload-artifact`, and this forge build
// (15.0.3+gitea-1.22.0) exposes NO Actions-artifact API — `GET /repos/{owner}/{repo}/actions/artifacts`
// answers 404 "404 page not found", a MISSING ROUTE, not an empty result. So the production APK was
// reachable only by a human clicking through the run page, and only until the artifact expired: no
// agent session, no phone-provisioning step and no future release-notes job could fetch it. This is
// the same gap that pushed CI failure evidence out of artifacts and into the generic registry (042).
//
// Forgejo has no Android/APK package type, so the vehicle is the GENERIC registry —
// `PUT {server}/api/packages/{owner}/generic/{package}/{version}/{filename}` — already proven on this
// instance by scripts/ci-failure-digest.mjs. It takes the SAME `write:package` scope the container
// push already uses (`actions-ci-push` → secret REGISTRY_TOKEN), so this adds no token and widens no
// scope.
//
// NEVER FAILS THE JOB (AC4). `prod-apk` is deliberately non-blocking — nothing `needs:` it — and a
// registry hiccup must not change that. Every failure path logs loudly (`::error::`, so it is visible
// in the job log) and then exits 0. That is belt AND braces with the workflow's `continue-on-error`.
//
// Usage:
//   node scripts/cd/publish-apk.mjs      # publish + prune; always exit 0
//
// Env (all supplied by the workflow step):
//   REGISTRY_TOKEN   write:package PAT (`actions-ci-push`). Absent ⇒ logged + skipped, exit 0.
//   GITHUB_SHA       commit being built; its first 7 chars form the version suffix.
//   GITHUB_SERVER_URL / GITHUB_REPOSITORY — forge base + owner (falls back to the origin remote).
//   APK_OUTPUT_DIR   override the APK search dir (tests only).
//   APP_JSON_PATH    override the app.json read for `expo.version` (tests only).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The generic package every prod APK lands in. One package, many versions. */
export const APK_PACKAGE = 'mcm-app-android';

/**
 * Retention (AC5). An APK is two to three ORDERS OF MAGNITUDE larger than a ci-failures digest bundle
 * (~80 MB vs ~5 MB) and every deploy produces one, so unbounded accumulation is a disk-exhaustion path
 * on the homelab host — not a tidiness concern. 10 × ~80 MB ≈ 800 MB is the ceiling this sets.
 *
 * COUNT-based, not the 30-day window ci-failures uses: a quiet month would delete every APK (leaving
 * nothing installable), and a busy week would keep far more than the disk can afford. "The last 10
 * builds" is the property an operator actually wants from an APK shelf.
 */
export const RETAIN_VERSIONS = 10;

/**
 * A version whose name ends in this suffix is NEVER pruned, and does not count against RETAIN_VERSIONS
 * — "plus anything explicitly pinned". Pinning is an operator act with no extra state to keep in sync:
 * re-upload (or rename) the build as `<version>-keep` and it survives every future prune.
 */
export const PIN_SUFFIX = '-keep';

/** Default location `mcm-app:build-apk` leaves the release APK in. */
const DEFAULT_APK_DIR = join(REPO_ROOT, 'frontend/mcm-app/android/app/build/outputs/apk/release');
const DEFAULT_APP_JSON = join(REPO_ROOT, 'frontend/mcm-app/app.json');

/** build-apk.mjs's descriptive copy, NOT Gradle's generic `app-release.apk`. */
const APK_PATTERN = /^MovieCollectionManager-.*\.apk$/;

// --- Pure helpers (unit-tested) -----------------------------------------------------------------

/**
 * Package version for this build: `<expo.version>-<sha7>`.
 *
 * Unique per COMMIT, which is what the generic registry needs — it rejects a re-upload of an existing
 * package/version/filename with a conflict rather than overwriting. Re-running the same commit is
 * therefore a 409, handled as "already published" rather than as a failure (the bytes are the same
 * build of the same source).
 */
export function apkVersion(appVersion, sha) {
  const v = String(appVersion ?? '').trim();
  if (!v) throw new Error('app.json has no expo.version — cannot form a package version');
  const short = String(sha ?? '').trim().slice(0, 7) || 'local';
  return `${v}-${short}`;
}

/**
 * Pick the versions to delete: everything past the newest RETAIN_VERSIONS, excluding pinned ones.
 *
 * Two deliberate conservatisms, both in the KEEP direction, because deleting the only installable
 * build of a release is the destructive error and a stale extra APK is not:
 *   - a version whose `created_at` will not parse is kept and does not consume a retention slot (the
 *     same rule ci-failure-digest's selectExpiredVersions applies to evidence);
 *   - pinned versions are kept AND excluded from the count, so pinning can never evict a fresh build.
 *
 * Sorting is by `created_at` DESC and never by name: the forge orders packages by NAME, not age, and
 * `1.10.0` sorts before `1.9.0` as a string — so name order would prune the newest build first.
 */
export function selectPrunableVersions(versions, { retain = RETAIN_VERSIONS, pinSuffix = PIN_SUFFIX } = {}) {
  const dated = [];
  for (const v of versions ?? []) {
    const name = String(v?.version ?? '');
    if (!name || name.endsWith(pinSuffix)) continue;
    const at = Date.parse(v.created_at ?? v.createdAt ?? '');
    if (!Number.isFinite(at)) continue;
    dated.push({ ...v, version: name, _at: at });
  }
  dated.sort((a, b) => b._at - a._at);
  return dated.slice(retain).map(({ _at, ...rest }) => rest);
}

/**
 * Locate the release APK. Returns null (never throws) when the build produced none — the caller logs
 * and skips, because a missing APK means the build step already failed and has already said so.
 */
export function findApk(dir) {
  if (!dir || !existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter((f) => APK_PATTERN.test(f))
    .map((f) => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return matches[0] ?? null;
}

/** `sha256sum -c` format — `<hex>␠␠<filename>` — so a downloader verifies with the stock tool. */
export function sha256Sidecar(hex, filename) {
  return `${hex}  ${filename}\n`;
}

// --- Transport ----------------------------------------------------------------------------------

/** Repo slug + API base from the runner env, falling back to the origin remote. Host never printed. */
export function forgeEndpoint(env = process.env) {
  const server = env.GITHUB_SERVER_URL;
  const slug = env.GITHUB_REPOSITORY;
  if (server && slug) {
    const [owner] = slug.split('/');
    return { base: `${server.replace(/\/$/, '')}/api/v1`, owner };
  }
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const m = origin.replace(/\.git$/, '').match(/^(https?:\/\/[^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) throw new Error('could not resolve the forge API base');
  return { base: `${m[1]}/api/v1`, owner: m[2] };
}

async function fetchWithTimeout(url, opts = {}, ms = Number(process.env.CI_HTTP_TIMEOUT_MS) || 300_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function packagesApi({ base, owner, token, fetchImpl = fetchWithTimeout }) {
  // The generic package registry lives OUTSIDE /api/v1, so it needs the bare server root.
  const packagesRoot = base.replace(/\/api\/v1$/, '/api/packages');
  const call = async (method, url, body, contentType) => {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `token ${token}`,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body,
    });
    return res;
  };
  return {
    upload: (version, filename, body, contentType) =>
      call('PUT', `${packagesRoot}/${owner}/generic/${APK_PACKAGE}/${version}/${filename}`, body, contentType),
    // PAGINATED, deliberately. The forge defaults to page 1 at 30 items and orders packages by NAME,
    // not age — so an unpaginated call stops seeing older versions once more than 30 exist, silently
    // degrading retention to a no-op with no error.
    listVersions: async () => {
      const out = [];
      for (let page = 1; page <= 100; page++) {
        const res = await call('GET', `${base}/packages/${owner}?type=generic&q=${APK_PACKAGE}&page=${page}&limit=50`);
        if (res.status === 404) break;
        if (!res.ok) throw new Error(`forge returned ${res.status} listing ${APK_PACKAGE} versions`);
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;
        out.push(...batch.filter((x) => x?.name === APK_PACKAGE));
        if (batch.length < 50) break;
      }
      return out;
    },
    deleteVersion: (version) => call('DELETE', `${base}/packages/${owner}/generic/${APK_PACKAGE}/${version}`),
  };
}

const log = (msg) => console.log(`[publish-apk] ${msg}`);
const fail = (msg) => console.log(`::error::[publish-apk] ${msg}`);

/** Delete the versions past the retention window. Never throws at the caller's expense (AC4/AC5). */
export async function pruneOldVersions(api, { retain = RETAIN_VERSIONS } = {}) {
  const versions = await api.listVersions();
  const pinned = versions.filter((v) => String(v.version ?? '').endsWith(PIN_SUFFIX)).length;
  const doomed = selectPrunableVersions(versions, { retain });
  log(`retention: ${versions.length} version(s) present, ${pinned} pinned, keeping the newest ${retain}, pruning ${doomed.length}`);
  let pruned = 0;
  for (const v of doomed) {
    try {
      const res = await api.deleteVersion(v.version);
      if (!res.ok && res.status !== 404) throw new Error(`forge returned ${res.status}`);
      pruned += 1;
      log(`pruned ${APK_PACKAGE}:${v.version}`);
    } catch (err) {
      // One stubborn version must not abort the rest of the prune, nor the run.
      console.log(`[publish-apk] prune of ${v.version} suppressed: ${err?.message ?? err}`);
    }
  }
  return { present: versions.length, pinned, pruned };
}

/**
 * Publish the APK + its SHA-256 sidecar, then prune. Returns a small outcome record for the caller
 * to log. Throws only for the caller's catch-all — `run()` converts everything to exit 0.
 */
export async function publish({ api, apk, version }) {
  const bytes = readFileSync(apk.path);
  const hex = createHash('sha256').update(bytes).digest('hex');
  const mb = (bytes.length / 1024 / 1024).toFixed(1);
  // AC6 leaves a MEASUREMENT in every run log rather than a one-off number in a document: if the
  // instance's [packages] LIMIT_SIZE_GENERIC / LIMIT_TOTAL_OWNER_SIZE ever start refusing this, the
  // size that was refused is right there next to the error.
  log(`publishing ${apk.name} (${mb} MB, sha256 ${hex}) as ${APK_PACKAGE}:${version}`);

  const res = await api.upload(version, apk.name, bytes, 'application/vnd.android.package-archive');
  if (res.status === 409) {
    // Same commit deployed twice. The bytes are the same build of the same source, so this is
    // "already published", not a failure — and overwriting would destroy an APK someone may have
    // pinned or installed from.
    log(`${APK_PACKAGE}:${version}/${apk.name} already exists (409) — leaving the published copy alone`);
  } else if (!res.ok) {
    throw new Error(`upload returned ${res.status}${res.status === 401 || res.status === 403 ? ' — REGISTRY_TOKEN is missing the `write:package` scope for this endpoint' : ''}`);
  }

  const sidecarName = `${apk.name}.sha256`;
  const sidecar = await api.upload(version, sidecarName, sha256Sidecar(hex, apk.name), 'text/plain');
  if (sidecar.status === 409) {
    log(`${sidecarName} already exists (409) — leaving it alone`);
  } else if (!sidecar.ok) {
    throw new Error(`sidecar upload returned ${sidecar.status}`);
  }

  return { version, filename: apk.name, sha256: hex, bytes: bytes.length };
}

async function run() {
  const token = process.env.REGISTRY_TOKEN;
  if (!token) {
    // A run with no secrets (an AGit-headed run) has no token. That is not a failure of this step.
    fail('REGISTRY_TOKEN is empty — the APK was built but NOT published to the package registry');
    return;
  }

  const apkDir = process.env.APK_OUTPUT_DIR || DEFAULT_APK_DIR;
  const apk = findApk(apkDir);
  if (!apk) {
    fail(`no MovieCollectionManager-*.apk found in ${apkDir} — nothing to publish`);
    return;
  }

  const appJsonPath = process.env.APP_JSON_PATH || DEFAULT_APP_JSON;
  const appVersion = JSON.parse(readFileSync(appJsonPath, 'utf8'))?.expo?.version;
  const version = apkVersion(appVersion, process.env.GITHUB_SHA);

  const { base, owner } = forgeEndpoint();
  const api = packagesApi({ base, owner, token });

  const published = await publish({ api, apk, version });
  // Host-free reference (the tailnet host never enters a log line that could be copied into git).
  log(`published ${APK_PACKAGE}:${published.version}/${published.filename} — pull it with the recipe in docs/runbooks/Server-Setup-Runbook.md §6.7`);

  // Opportunistic retention: there is no scheduled pipeline for this, so each publish prunes. A
  // pruning failure must never fail the publish or the job.
  await pruneOldVersions(api).catch((err) => fail(`prune suppressed: ${err?.message ?? err}`));
}

// `import.meta.main`-style guard so the unit tests can import the helpers without running the CLI.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  run()
    .catch((err) => fail(`publish suppressed: ${err?.message ?? err}`))
    // ALWAYS 0 (AC4). prod-apk is non-blocking by design and a registry hiccup must not change that.
    .finally(() => process.exit(0));
}
