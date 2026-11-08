# Plan 096: Unused code removed, and four backup suites fail by name

**Spec**: [spec.md](./spec.md)

## Approach

- Delete the unused imports, destructured names and the `navigateToFirstMovie` helper in `movies.spec.ts`.
  The cross-user job case `destinationB` was seeded for is already covered: B aiming a job at A's
  destination (`backup-jobs-authz`), and the update path (`backup-job-store.integration.test.ts`).
- Add `beforeAll(() => assertBackupTargetsPresent())` to the four suites, declared before their seeding
  `beforeAll`. Jest runs no hook in a file whose tests are all skipped, so the default (targets down, flag
  unset) still skips cleanly, which is the behaviour the existing seeding hooks already rely on.

## Rollback

Revert the commit.
