/**
 * The pipeline must never reach the user's own storage (feature 076, T013 — FR-023).
 *
 * This is a STATIC IMPORT ASSERTION, not a behavioural one, and that is deliberate. FR-023 says
 * the artifacts at the user's destination are not deleted, not modified, and not even
 * authenticated to. A behavioural test can only show that a particular code path did not touch
 * them on a particular run; reading the imports shows that the capability is absent entirely.
 *
 * The risk is concrete rather than theoretical. `backup-destination-driver.ts` declares
 * `delete(key)` and `backup-retention.ts` already calls it against the user's own storage during
 * retention pruning. "Delete the account and clean up their backups" is a plausible reading of
 * this feature and a wrong one, and the machinery to act on it is one import away.
 *
 * If this fails, remove the import. Do not relax the test.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const PIPELINE = join(__dirname, '..', 'account-deletion.ts');

/** Modules that can authenticate to, write to, or delete from a user's own destination. */
const FORBIDDEN = [
  'backup-destination-driver',
  'backup-retention',
  'backup-driver-s3',
  'backup-driver-webdav',
  'backup-destination-store',
  'backup-restore-writer',
];

describe('account-deletion.ts imports', () => {
  const source = readFileSync(PIPELINE, 'utf8');

  /** Import specifiers only — a mention inside a comment is documentation, not a capability. */
  const specifiers = [...source.matchAll(/(?:from\s+|require\()\s*['"]([^'"]+)['"]/g)].map(
    (m) => m[1],
  );

  it.each(FORBIDDEN)('does not import %s', (mod) => {
    expect(specifiers.filter((s) => s.includes(mod))).toEqual([]);
  });

  it('imports the backup teardown, which is the only backup module it may touch', () => {
    expect(specifiers.some((s) => s.includes('backup-offline-token'))).toBe(true);
  });

  it('never names the driver delete method anywhere in the module', () => {
    expect(source).not.toMatch(/\bdriver\s*\.\s*delete\b/);
    expect(source).not.toMatch(/\bcreateDestinationDriver\b/);
  });
});
