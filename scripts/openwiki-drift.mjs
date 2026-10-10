// The drift comparison: has a concept's cited source been committed since the concept's stamp?
// Feature 082 D1. ONE definition, imported by V12 (check-openwiki-okf.mjs), by wiki-maintain's
// stale-page check (#587, #616) and by its drift planner, so the three cannot disagree.
//
// Commit date, never mtime: a fresh checkout stamps every file with the checkout time, so an mtime
// comparison reports every concept as stale in CI. The one exception is explicit: V12 falls back to
// mtime for an UNTRACKED source (a warning is harmless there), while the planner and the verifier
// treat it as "cannot judge", because a guess there would cost a paid run or fail a slice.
//
// The stamp is the NEWEST of generated.at, verified.at and timestamp (./openwiki-stamp.mjs).

import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { conceptStamp } from './openwiki-stamp.mjs';

const commitDates = new Map();

function lastCommitDate(root, path) {
  const key = `${root}\0${path}`;
  if (!commitDates.has(key)) {
    const r = spawnSync('git', ['log', '-1', '--format=%cI', '--', path], { cwd: root, encoding: 'utf8' });
    const out = r.status === 0 ? r.stdout.trim() : '';
    commitDates.set(key, out === '' ? null : new Date(out));
  }
  return commitDates.get(key);
}

const isExternal = (value) => {
  try {
    const url = new URL(value);
    // A Windows drive letter parses as a one-letter protocol; that is a path, not a URL.
    return !/^[a-z]:$/i.test(url.protocol);
  } catch {
    return false;
  }
};

/**
 * Judge one concept's front matter against its cited source, resolved from the repository root.
 *
 * Returns:
 *   - null: cannot judge (no resource, an external one, a source that does not exist, or an
 *     untracked one without `fallbackToMtime`);
 *   - `{ unstampable: true, source }`: a source V12 could check but the page carries no usable stamp.
 *     V12 counts these, so a migration that strips stamps shows up as coverage falling;
 *   - `{ stale, source, sourceDate, stampMs, directory }`: judged. A directory resource is judged by
 *     its newest commit, and `directory` lets a caller treat it as permanently re-flaggable.
 */
export function sourceCommitAfterStamp({ root, fields, fallbackToMtime = false }) {
  const value = typeof fields?.resource === 'string' ? fields.resource.trim() : '';
  if (value === '' || isExternal(value)) return null;
  const source = value.split('#')[0].split('?')[0];
  const abs = join(root, source);
  if (source === '' || !existsSync(abs)) return null;

  const stamp = conceptStamp(fields);
  const stampMs = stamp === null ? NaN : Date.parse(stamp.value);
  if (Number.isNaN(stampMs)) return { unstampable: true, source };

  let sourceDate = lastCommitDate(root, source);
  if (sourceDate === null) {
    if (!fallbackToMtime) return null;
    sourceDate = statSync(abs).mtime;
  }
  return { stale: sourceDate.getTime() > stampMs, source, sourceDate, stampMs, directory: statSync(abs).isDirectory() };
}
