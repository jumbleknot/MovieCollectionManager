/**
 * Are the feature-073 backup destinations up? (S3 + WebDAV)
 *
 * These live in their OWN compose file and are NOT part of the stack CI's app-e2e brings up, so
 * the suites that need them must not simply fail there. Equally they must not simply pass: a
 * skipped test reads as a pass, and that is the failure mode this whole feature's suites are
 * written against.
 *
 * So this follows the repository's existing skip-escalation convention exactly — the one
 * `MCM_REQUIRE_LIVE_STACK` implements for the rest of this tier:
 *
 *   targets absent, flag unset  → SKIP, loudly labelled, proving nothing and claiming nothing
 *   targets absent, flag SET    → HARD FAILURE, naming the missing input
 *   targets present             → run for real
 *
 * Set MCM_REQUIRE_BACKUP_TARGETS=1 wherever the targets are supposed to be up — locally, and in
 * CI once app-e2e is wired to bring them up. The preflight
 * (tests/integration/setup/preflight.global.js) probes them under the same flag.
 *
 * Bring them up with:
 *   docker compose -p mcm --env-file infrastructure-as-code/docker/stacks/mcm.env \
 *     -f infrastructure-as-code/docker/backups/compose.yaml up -d
 */
export const BACKUP_TARGETS_PRESENT = Boolean(process.env.BACKUP_TEST_S3_SECRET_KEY);
export const REQUIRE_BACKUP_TARGETS = process.env.MCM_REQUIRE_BACKUP_TARGETS === '1';

/** True when this suite should be skipped rather than run or failed. */
export const SKIP_WITHOUT_BACKUP_TARGETS = !BACKUP_TARGETS_PRESENT && !REQUIRE_BACKUP_TARGETS;

/**
 * `describe` / `it` that skip when the targets are absent — UNLESS the escalation flag is set,
 * in which case they run and fail on the explicit assertion below.
 */
export const describeBackupTargets = SKIP_WITHOUT_BACKUP_TARGETS ? describe.skip : describe;
export const itBackupTargets = SKIP_WITHOUT_BACKUP_TARGETS ? it.skip : it;

/**
 * The assertion that makes the skip honest. Put it at the top of every suite that needs the
 * targets: with the flag set and the targets missing it fails here, naming the input, rather
 * than as N identical connection errors further down.
 */
export function assertBackupTargetsPresent(): void {
  expect(
    BACKUP_TARGETS_PRESENT ||
      'BACKUP_TEST_S3_SECRET_KEY is unset — the backup destinations are not up. ' +
        'docker compose -p mcm --env-file infrastructure-as-code/docker/stacks/mcm.env ' +
        '-f infrastructure-as-code/docker/backups/compose.yaml up -d',
  ).toBe(true);
}
