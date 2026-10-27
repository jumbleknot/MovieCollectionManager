# Tasks: Silent-failure visibility: backups, deploys and app-image scans

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md) (R1–R14),
[data-model.md](./data-model.md), [contracts/cli-contracts.md](./contracts/cli-contracts.md),
[quickstart.md](./quickstart.md)

**Tests**: TDD is mandatory (constitution). Every test task carries a **Verify RED** command and the
failure it expects; every paired implementation task carries a **Verify GREEN** command, and a
**mutation** wherever SC-006 applies. The format follows
`docs/templates/feature-test-tasks-template.md`. Operator tasks are marked **(operator)**. They are
acceptance steps on the real host or forge, with the paste block and expected output in quickstart.md.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, and no dependency on an incomplete task)
- **[Story]**: US1–US5 from spec.md
- **PR**: each story ships as its own PR. Delivery order: **A**=US1, then **B**=US4 (same script, so
  it opens after A merges); **C**=US2, **D**=US3 and **E**=US5 are independent. Open PR #864 is
  FR-019b of US4.

## Conventions (apply to every task)

- **Worktrees only.** Commit from `/home/coder/worktrees/084-<pr-slug>`, never from `/workspaces/mcm`:
  - create the worktree with `git worktree add -b <branch> /home/coder/worktrees/<slug> origin/main`,
    after the spec PR merges, or from `084-silent-failure-visibility` before it;
  - then `ln -s /workspaces/mcm/node_modules node_modules`.
  - `pnpm nx` will not run in a worktree without a real install. Run `node --test` and the gate
    scripts directly.
- **`node --test`**: node's flags go **before** the path. Read the `ℹ pass` / `ℹ fail` lines from a
  file, because rtk condenses piped output:
  `node --test scripts/__tests__/X.test.mjs > "$SCRATCH/t.txt" 2>&1; grep -E '^ℹ (tests|pass|fail)' "$SCRATCH/t.txt"`.
- **Host-script tests are unit tests.** They run the real bash scripts against fake `docker`, `restic`,
  `curl` and `python3` shims put first on `PATH`, built by the shared helper (T003). Each shim
  appends its argv to a call log and answers from a fixture. No test touches a real host,
  forge or NAS.
- **Every new CI step** wrapped by `ci-log-step.sh` is calibrated in `scripts/ci-step-ceilings.tsv`,
  or listed there ON THE BACKSTOP.
- **Every PR** ends with `node scripts/preflight.mjs --gates-only` passing (24 or more checks). It is
  opened with `git push origin HEAD:<branch>` and then `POST /api/v1/repos/jumbleknot/mcm/pulls`
  using the `git credential fill` token, never an AGit push.

---

## Phase 1: Setup

- [x] T001 Commit the verbatim host baseline. The three files are already written in the spec
  worktree: `infrastructure-as-code/backup/backup.sh`, `infrastructure-as-code/backup/homelab-backup.service`
  and `infrastructure-as-code/backup/homelab-backup.timer`. Their sha256 must match the host exactly:
  `2ce6ffd0…`, `c068245d…` and `bbb8a3db…` (research R14). Move them to the PR A worktree, branch
  `084-us1-backup-alerting`, and commit them **unchanged** as the first commit, titled
  `chore(backup): host backup script and units, verbatim (sha256 matches prod)`.
  **Done when**: `sha256sum infrastructure-as-code/backup/{backup.sh,homelab-backup.service,homelab-backup.timer}`
  prints the three host hashes.
- [ ] T002 Create the PR worktrees as each PR becomes ready: `084-us1-backup-alerting` (A),
  `084-us4-backup-size` (B, from A's merge), `084-us2-ci-status-deploy` (C), `084-us3-app-image-scan` (D)
  and `084-us5-registry-retention` (E), all under `/home/coder/worktrees/`. Push each branch right
  after its first commit, because a worktree does not survive a container rebuild.
- [x] T003 Add the shared shim helper `scripts/__tests__/host-shims.mjs`:
  - `makeShimEnv({ fixtures })` creates a temp dir holding a fake HOME (with `backup/`,
    `backup/state/` and `.config/systemd/user/`) and a `bin/` holding executable shims for `docker`,
    `restic`, `curl`, `python3` and `systemctl`;
  - each shim logs `argv` as one JSON line to `calls.jsonl`, and writes the stdout and exit code its
    fixture gives for a matching argv prefix; `python3` passes through to the real interpreter
    unless a fixture overrides it;
  - it returns `{ env, home, calls(), run(script, args) }`.
  **Done when**: `node --test scripts/__tests__/host-shims.test.mjs` passes 3 tests: a shim records
  argv, a fixture exit code propagates, and real `python3` passes through.

## Phase 2: Foundational (blocks US1 and US4)

- [x] T004 [P] Test: `scripts/__tests__/backup-install-manifest.test.mjs` checks that
  `infrastructure-as-code/backup/INSTALLED.sha256` lists **every** `*.sh`, `*.service`, `*.timer` and
  `*.sql` file in `infrastructure-as-code/backup/`, with its current sha256 and its install path
  (`backup/<f>` for scripts and SQL, `.config/systemd/user/<f>` for units). It fails on a missing,
  extra or stale line, and `--check` mode exits 1 on drift (FR-004).
  **Verify RED**: `node --test scripts/__tests__/backup-install-manifest.test.mjs`. Expected: fails,
  `INSTALLED.sha256 not found`.
- [x] T005 Implement `scripts/backup-install-manifest.mjs`, which takes `--write` or `--check`, and
  rejects any other argument with exit 2 through the repository's shared rejecting parser. Generate
  `infrastructure-as-code/backup/INSTALLED.sha256` from the T001 baseline.
  **Verify GREEN**: the T004 command; all pass. **Mutation**: append a byte to `backup.sh`, then the
  test fails naming `backup.sh`; revert.

---

## Phase 3: US1: A failed or stale prod backup is visible without anyone looking (P1), PR A, item #830 🎯 MVP

**Goal**:
- A failed or hung run, or a stale newest snapshot (36 h), opens or updates one p1 backlog item.
- A failing forge dump no longer skips the other dumps.
- Empty, truncated or shrunken dumps are caught.
- The runbook matches the script.

**Independent test**: quickstart US1 steps 1–6.

### Tests

- [x] T006 [P] [US1] Test: `scripts/__tests__/backup-script.test.mjs`, case **"a failing forge dump
  does not skip the others"** (US1-AC3, FR-003). The `docker` shim fails `forgejo dump` with exit 1.
  Assert:
  - the script exits 1, because a dump failed;
  - the Komodo, Keycloak, agent-db, mc-service-mongo and bff-mongo dump commands **all** appear in
    `calls.jsonl`;
  - `restic backup` and `restic forget` were both called;
  - the staging dir handed to `restic backup` contains `DUMP-FAILED-forge`.
  **Verify RED**: `node --test --test-name-pattern="forge dump does not skip" scripts/__tests__/backup-script.test.mjs`.
  Expected: 1 failing. Against the baseline, no later dump runs and restic is never called.
- [x] T007 [P] [US1] Test: in the same file, cases **"each dump is checked in its own format"**
  (US1-AC3a, FR-003a):
  - a plain-SQL dump missing its `-- PostgreSQL database dump complete` trailer gives verdict
    `failed-format`;
  - a `.archive.gz` that fails `gzip -t` (a truncated real gzip fixture) gives `failed-format`;
  - a tar that fails `tar -tf` gives `failed-format`;
  - a zero-byte Keycloak dump gives `failed-min`;
  - a 670-byte agent-db dump gives `ok`, because its minimum is 1.

  Each failure writes `DUMP-FAILED-<name>`, makes the run exit 1, and is recorded in
  `dump-manifest.tsv` with the data-model columns.
  **Verify RED**: `node --test --test-name-pattern="checked in its own format" scripts/__tests__/backup-script.test.mjs`.
  Expected: 5 failing. The baseline has no checks and no manifest.
- [x] T008 [P] [US1] Test: cases **"shrink against the last good run"** (US1-AC3b, FR-003b):
  - with `state/last-good.tsv` giving Keycloak 381023 and a new dump of 100000, the verdict is
    `alert-shrink`, `backup-alert.sh shrink` is called with a detail naming `keycloak 381023 → 100000`,
    and the snapshot **is** still uploaded;
  - with `state/ack-shrink-keycloak` present, the verdict is `ack-shrink`, no alert is sent, and the
    ack file is deleted after the run;
  - with no `last-good.tsv`, the manifest says `compare=skipped (no previous manifest)`;
  - only a fully `ok` run rewrites `last-good.tsv`;
  - `backup.sh --ack-shrink keycloak` writes the ack file and exits 0; `--ack-shrink nope` exits 2.
  **Verify RED**: `node --test --test-name-pattern="shrink against" scripts/__tests__/backup-script.test.mjs`.
  Expected: 6 failing.
- [x] T009 [P] [US1] Test: static and runtime guards **"measured failure modes stay fixed"** (FR-004):
  1. The staging path is under `$HOME/backup`, not `/tmp`, `/dev/shm` or `$XDG_RUNTIME_DIR`, and
     `--check-staging` exits 1 when the `stat` shim reports `tmpfs`.
  2. Every `restic forget` line has `--tag homelab` and `--group-by host,tags`.
  3. The script contains no literal that `scanText` from `scripts/secret-scan.mjs` (its `RULES`)
     flags.
  4. Unknown arguments (`--dry-run`, `--help`, `x`) exit 2 with a usage message, and **no** `docker`
     or `restic` call is logged.
  5. Every failure path still runs `restic backup`.
  **Verify RED**: `node --test --test-name-pattern="measured failure modes" scripts/__tests__/backup-script.test.mjs`.
  Expected: 1, 4 and 5 fail on the baseline. 2 and 3 already hold and **must** be shown RED by
  mutation: delete `--group-by host,tags`, and add `KPASS=hunter2-…`. Record both in the PR.
- [x] T010 [P] [US1] Test: `scripts/__tests__/backup-alert.test.mjs` (FR-001, R1, contract
  `backup-alert.sh`). The `curl` shim serves the issue search and create/comment endpoints. Assert:
  - with no open item titled `Prod backup: failed or stale`, it POSTs a create carrying labels
    `type/bug` and `priority/p1`;
  - with an open item, it POSTs a comment and **never** a second create;
  - the search query carries `type=issues` and **no** label filter;
  - `recovered` with no open item makes no POST and exits 0, and `recovered` never sends
    `state=closed`;
  - an unknown reason exits 2;
  - `failed homelab-backup.service` with the `systemctl` shim answering `Result=timeout` reports
    `hung`, and with `Result=exit-code` reports `failed`;
  - a missing token file, or one not mode 600, exits 3 with `alert NOT delivered`;
  - an HTTP 500 exits 4;
  - the token value never appears in stdout, stderr or `calls.jsonl` argv (it travels via `-H @file`);
  - a detail line carrying `mongodb://u:p@h` is sent as `mongodb://***@h`, and a line containing
    `PGPASSWORD=` or `Authorization:` is dropped.
  **Verify RED**: `node --test scripts/__tests__/backup-alert.test.mjs`. Expected: all failing,
  `backup-alert.sh: No such file`.
- [ ] T011 [P] [US1] Test: `scripts/__tests__/backup-staleness.test.mjs` (FR-002, R3, contract
  `backup-staleness.sh`). The `restic` shim returns `snapshots --json` fixtures:
  - newest snapshot 2 h old: exit 0, no alert;
  - 37 h old: exit 1 and `backup-alert.sh stale`;
  - restic exits 1, the list is empty, or the time is unparsable: exit 1 and
    `staleness-unreadable` (never "fresh");
  - `MCM_BACKUP_STALE_HOURS=0` forces stale;
  - none of the unit files sets `MCM_BACKUP_STALE_HOURS`.
  **Verify RED**: `node --test scripts/__tests__/backup-staleness.test.mjs`. Expected: all failing.
- [ ] T012 [P] [US1] Test: `scripts/__tests__/backup-units.test.mjs` parses the unit files as INI
  (FR-001, FR-002, R2):
  - `homelab-backup.service` has `OnFailure=homelab-backup-alert@%n.service` and
    `TimeoutStartSec=2h`;
  - `homelab-backup-alert@.service` exists, is `Type=oneshot`, and runs `backup-alert.sh failed %i`;
  - `homelab-backup-staleness.timer` has `OnCalendar` every 6 h and `Persistent=true`, and is
    `WantedBy=timers.target`;
  - `homelab-backup-staleness.service` runs `backup-staleness.sh` and does **not** have the backup's
    `OnFailure` (it alerts itself);
  - the backup timer keeps `03:30` and `Persistent=true`.
  **Verify RED**: `node --test scripts/__tests__/backup-units.test.mjs`. Expected: failing on
  `OnFailure` missing and the alert/staleness units not found.

### Implementation

- [x] T013 [US1] In `infrastructure-as-code/backup/backup.sh`, add:
  - an argument parser at the top (no args | `--ack-shrink <name>` | `--check-staging`; anything
    else exits 2 before any side effect);
  - a tool check for `curl` and `python3`;
  - `run_dump <name> <min> <max|-> <format> <file> -- <cmd…>`, which runs the command and, on a
    non-zero exit, writes `DUMP-FAILED-<name>` and returns 0 (R4);
  - `check_dump`, implementing R5's format table;
  - the manifest writer (data-model).

  Convert **all six** existing dumps to `run_dump` **without changing their commands**. Komodo's
  stderr changes from `/dev/null` to the run log; R8's command change belongs to US4. The forge dump
  keeps `forgejo dump` in this PR, under the name `forge`, format `tar.gz`, checked with
  `tar -tzf`. Set the run outcome and exit code per data-model, and keep restic `backup`/`forget`
  running on every path.
  **Verify GREEN**:
  `node --test --test-name-pattern="forge dump does not skip|checked in its own format|measured failure modes" scripts/__tests__/backup-script.test.mjs`.
  All pass. **Mutation**: make the forge dump fatal again (`|| return 1` in `run_dump`), and T006
  fails.
- [x] T014 [US1] Implement the shrink comparison, `--ack-shrink`, the `last-good.tsv` rewrite on an
  `ok` run only, and the success-path `backup-alert.sh recovered` call (data-model, R5). All of these
  go in `backup.sh`.
  **Verify GREEN**: `node --test --test-name-pattern="shrink against" scripts/__tests__/backup-script.test.mjs`.
  All pass. **Mutation**: compare with `<=` against 0 instead of 0.5×, and the alert case fails.
- [x] T015 [P] [US1] Implement `infrastructure-as-code/backup/backup-alert.sh` per R1 and the
  contract. Use `curl -fsS -H @"$HOME/backup/forge-issue-token.header"`, where the header file is
  derived from the mode-600 token file at runtime in a `mktemp` that is removed on exit. Build JSON and
  parse the search response with `python3`, and redact the detail before it leaves the host. The redaction is host-specific, not
  `scripts/secret-scan.mjs`'s `RULES`, which match repository-leak shapes (provider API keys,
  dev-credential placeholders) and not what a backup journal can carry. It replaces URI user-info
  (`scheme://user:pass@` becomes `scheme://***@`), and drops any line containing `PASSWORD`,
  `PASSWD`, `SECRET`, `TOKEN` or `Authorization`, case-insensitively. The
  forge URL comes from `MCM_FORGE_URL`, which is **required, with no default**: the real host must never
  be committed (`check-topology-scrub`). The install block writes it into `~/backup/alert.env` on
  the host. The repo is `jumbleknot/mcm`. A test asserts that an unset `MCM_FORGE_URL` exits 3, like a
  missing token.
  **Verify GREEN**: `node --test scripts/__tests__/backup-alert.test.mjs`. All pass. **Mutation**:
  drop the "search first" call, and the "never a second create" case fails.
- [ ] T016 [P] [US1] Implement `infrastructure-as-code/backup/backup-staleness.sh`. It sets the same
  three exports as `backup.sh` (`DOCKER_HOST`, `RESTIC_REPOSITORY` and `RESTIC_PASSWORD_FILE`, from
  R14), runs `restic snapshots --tag homelab --latest 1 --json`, and computes the age with `python3`.
  The threshold is `${MCM_BACKUP_STALE_HOURS:-36}`.
  **Verify GREEN**: `node --test scripts/__tests__/backup-staleness.test.mjs`. All pass.
  **Mutation**: treat an empty list as age 0, and the unreadable case fails.
- [ ] T017 [P] [US1] Edit `infrastructure-as-code/backup/homelab-backup.service` to add `OnFailure=`
  and `TimeoutStartSec=2h`. Add `homelab-backup-alert@.service`, `homelab-backup-staleness.service`
  and `homelab-backup-staleness.timer` alongside it.
  **Verify GREEN**: `node --test scripts/__tests__/backup-units.test.mjs`. All pass.
- [ ] T018 [US1] Regenerate `infrastructure-as-code/backup/INSTALLED.sha256`
  (`node scripts/backup-install-manifest.mjs --write`). Write `infrastructure-as-code/backup/README.md`
  with:
  - the paste-safe install block: create the two token files with mode 600 from a prompt-free source,
    `install -m 0750` the scripts, `install -m 0644` the units, `systemctl --user daemon-reload`,
    `systemctl --user enable --now homelab-backup-staleness.timer`;
  - the comparison command (quickstart US1-6).
  **Done when**: the T004 test passes, and the README's block names every file in `INSTALLED.sha256`.
- [ ] T019 [US1] Rewrite the Backups section of `docs/runbooks/Server-Setup-Runbook.md` (lines
  ~1061–1070, now stale) to match the script, FR-005. Cover:
  - on-disk staging;
  - the forge registry and repository archives, which are excluded, and how to restore without them;
  - retention `--tag homelab --group-by host,tags` and why;
  - the alert item and staleness timer;
  - `--ack-shrink`;
  - the 2026-07-27..10-22 outage as a case study, quoting the measured baseline.
  **Done when**: `node scripts/check-openwiki-governance.mjs` and the docs link checks in preflight
  pass, and every claim in the section matches a line of `backup.sh`.
- [ ] T020 [US1] Run the PR A gate: the full `node --test scripts/__tests__/*.test.mjs` run passes, and
  `node scripts/preflight.mjs --gates-only` passes. Open PR A with a body that lists the RED→GREEN
  results and the mutations from T006–T017.
- [ ] T021 [US1] **(operator)** After PR A merges, run quickstart **0a** first if anything changed.
  Create the issue-scoped host token in the forge UI (scope: issues only), and install per the README.
  Then run quickstart US1 steps 1–2 and 5–6, and paste the output:
  - two timers listed;
  - the induced failure opens the item, and a second failure comments on it;
  - staleness `stale` and `staleness-unreadable` fire;
  - checksums all `OK`.
  **Done when**: the item exists with ≥ 3 comments from the induced events. The operator then
  comments, and the item stays open until T040.

**Checkpoint**: US1 alerting is live on the host. US1-AC5, the restore drill, runs against the
**new** dump format in US4 (T040).

---

## Phase 4: US4: The backup carries only what a restore needs (P2), PR B (after A), plus PR #864

**Goal**: the forge's share of a snapshot drops from ~21.5 GiB to under 2 GiB, new data per night
drops below 2 GiB, and Komodo's dump drops below 250 MB. Diagnostic artifacts get a deliberate
retention.

**Independent test**: quickstart US4.

- [x] T022 [US4] **(operator)** Run quickstart **0h**, `du -sh ~/forgejo ~/komodo ~/rustfs ~/nx-cache`
  plus their listings, and paste the output. Record the sizes and the keep/exclude decision for each
  directory in research.md R14. A rebuildable build cache is excluded; object-store data is kept.
  **Done when**: R14 has the four sizes and a decision for each.
- [ ] T023 [US4] Confirm that PR #864 (FR-019b, the Maestro scope) is merged, and that the first
  failing mobile run after the merge uploads `maestro-debug` under 50 MB. Check with
  `node scripts/ci-status.mjs` or the forge database query from Block 5a. Record the size in the spec
  baseline.
  **Done when**: one post-merge `maestro-debug` artifact has been measured. If no mobile failure has
  occurred yet, record "pending first failure" and continue; it does not block PR B.

### Tests

- [ ] T024 [P] [US4] Test: in `scripts/__tests__/backup-script.test.mjs`, case **"the forge is backed
  up as a database dump plus a data tar without diagnostics"** (FR-017–FR-019a, R7):
  - `forgejo dump` is **never** called;
  - `pg_dump -Fc` runs in `forgejo-forgejo-db-1` and produces dump `forge-db`, format `pg-custom`;
  - `docker exec forgejo-forgejo-1 tar -cf - -C /data` produces dump `forge-data`, format `tar`,
    **uncompressed**, with no `z` flag and no gzip pipe;
  - its `--exclude` set is **exactly** `gitea/actions_artifacts gitea/packages gitea/repo-archive
    gitea/indexers gitea/queues gitea/tmp gitea/log gitea/sessions`;
  - `check_dump` fails `forge-data` when the tar listing lacks `git/repositories/`,
    `gitea/conf/app.ini` or `gitea/jwt/`.
  **Verify RED**: `node --test --test-name-pattern="database dump plus a data tar" scripts/__tests__/backup-script.test.mjs`.
  Expected: failing, because `forgejo dump` is still called.
- [ ] T025 [P] [US4] Test: case **"Komodo's dump excludes its scheduler history"** (FR-019d, R8):
  - `pg_dumpall` is called only with `--globals-only`;
  - for each database the `psql` shim lists (`postgres`, `komodo`), `pg_dump` runs with
    `--exclude-table-data=cron.job_run_details`;
  - the Komodo files are concatenated or kept per database, and the manifest records them as dump
    `komodo` with `max_bytes` 500000000;
  - a 600 MB fixture gives verdict `warn-max` and `backup-alert.sh komodo-oversize`, with the snapshot
    still uploaded;
  - no Komodo command redirects stderr to `/dev/null`.
  **Verify RED**: `node --test --test-name-pattern="scheduler history" scripts/__tests__/backup-script.test.mjs`.
  Expected: failing on `pg_dumpall` without `--globals-only`.
- [ ] T026 [P] [US4] Test: `scripts/__tests__/komodo-cron-retention.test.mjs` reads
  `infrastructure-as-code/backup/komodo-cron-retention.sql`:
  - it unschedules `purge-cron-run-history` if it exists, then schedules it hourly;
  - it deletes `end_time < now() - interval '3 days'`;
  - it touches no other table;
  - it is idempotent: no bare `cron.schedule` without the preceding unschedule guard.
  **Verify RED**: `node --test scripts/__tests__/komodo-cron-retention.test.mjs`. Expected: failing,
  file not found.
- [ ] T027 [P] [US4] Test: case **"release APKs are dumped from the package API"** (R10). The `curl`
  shim lists the `mcm-app-android` generic package versions and files. Assert:
  - each file is downloaded with `-H @<package-token header>` into `release-apks/<version>/`;
  - a missing package token file gives `DUMP-FAILED-release-apks` and an alert, while the other dumps
    and restic still run;
  - the token never appears in argv.
  **Verify RED**: `node --test --test-name-pattern="release APKs" scripts/__tests__/backup-script.test.mjs`.
  Expected: failing.
- [ ] T028 [P] [US4] Test: `scripts/__tests__/upload-artifact-retention.test.mjs` parses every
  `.forgejo/workflows/*.yml` (FR-019c, R9):
  - every step using `actions/upload-artifact` has `with.retention-days`;
  - the value is at most 30;
  - diagnostic names (`maestro-debug`, `*-logs`, `*-report`, `*scan*`) have at most 14;
  - the release APK artifact has at most 7.
  **Verify RED**: `node --test scripts/__tests__/upload-artifact-retention.test.mjs`. Expected:
  failing, listing every current upload step (none sets it today).

### Implementation

- [ ] T029 [US4] In `infrastructure-as-code/backup/backup.sh`, replace the `forge` dump with
  `forge-db` + `forge-data` per R7, and the Komodo `pg_dumpall` with globals plus per-database
  `pg_dump` per R8. Add the `release-apks` dump per R10. Apply the T022 decision to the `restic backup`
  path list or its `--exclude` set.
  **Verify GREEN**: `node --test scripts/__tests__/backup-script.test.mjs`. All pass, including the
  US1 cases. **Mutations**:
  - remove `--exclude=gitea/actions_artifacts`, and T024 fails;
  - remove `--exclude-table-data`, and T025 fails.
- [ ] T030 [P] [US4] Write `infrastructure-as-code/backup/komodo-cron-retention.sql`.
  **Verify GREEN**: `node --test scripts/__tests__/komodo-cron-retention.test.mjs`. All pass.
- [ ] T031 [P] [US4] Add `retention-days` to every `upload-artifact` step in
  `.forgejo/workflows/app-ci.yml`, `cd-deploy.yml`, `infra-image-scan.yml`, `guardrails.yml`, and any
  other workflow T028 lists. In the runbook's forge compose block, add
  `FORGEJO__actions__ARTIFACT_RETENTION_DAYS=30` as the server default.
  **Verify GREEN**: `node --test scripts/__tests__/upload-artifact-retention.test.mjs`. All pass. Also
  run the app-ci guards (`node --test scripts/__tests__/app-ci*.test.mjs`), which must still pass.
- [ ] T032 [US4] Regenerate `INSTALLED.sha256`, and extend the README install block with:
  - the package token file;
  - the Komodo SQL apply step (`docker exec -i komodo-postgres-1 psql … < komodo-cron-retention.sql`);
  - the one-off purge and `VACUUM FULL`.
  In the runbook Backups section, add:
  - the FR-017 measurement command, which is the Block 4 `du` plus `pg_total_relation_size`;
  - the dated per-component table and the keep/exclude classification with restore consequences
    (FR-018, from R7's table);
  - the new restore procedure (`pg_restore` + untar, then a forge restart, which rebuilds the
    indexes).
  **Done when**: the T004 test and the preflight docs checks pass.
- [ ] T033 [US4] Run the PR B gate: the full `node --test scripts/__tests__/*.test.mjs` run and
  `preflight --gates-only` pass. Open PR B.
- [ ] T034 [US4] **(operator)** After PR B merges:
  1. Create the `read:package`-only host token.
  2. Install per the README.
  3. Apply `komodo-cron-retention.sql`.
  4. Run the one-off `DELETE … WHERE end_time < now() - interval '3 days'` and
     `VACUUM FULL cron.job_run_details`, and paste the timing.
  5. The next morning, paste `journalctl --user -u homelab-backup --since yesterday | grep -E 'Added to the repository|dump-manifest|verdict'`.

  Expected:
  - `forge-data` + `forge-db` total about 1.5 GB;
  - Komodo is under 250 MB;
  - the first night's shrink alerts for `forge` and `komodo` show as `ack-shrink`, because the
    operator acked both before the run with `backup.sh --ack-shrink`.
- [ ] T035 [US4] **(operator)** On the **second** night, paste the same journal line. Expected:
  `Added to the repository` is under 2 GiB (SC-008, FR-019a). A day after T034, re-run quickstart 0c.
  Expected: `min(end_time)` is within 3 days, and the table is under 75 MB.
- [ ] T036 [US4] **(operator)** Re-run quickstart **0e** on an artifact uploaded after PR B. Record in
  research R9 whether `expired_unix − created_unix` is 14 days or 90. If it is 90, the server default
  carries the requirement alone; record that in the runbook.
- [ ] T037 [US4] Record the before and after figures in the runbook and in the spec baseline (SC-008):
  - forge share 21.5 GiB → measured;
  - per-night added ~20 GiB → measured;
  - Komodo 2.0 GB → measured;
  - the Komodo table 2,147 MB → measured.
  **Done when**: all four after-values are filled in from T034–T035 output.

---

## Phase 5: US1 + US4 close-out: restore drill, item #830

- [ ] T038 [US1] Write the restore-drill section of the runbook (FR-006, quickstart US1-7):
  - restore `forge-db` into a scratch `postgres:18-alpine`, then count the rows of `repository` and
    `user`;
  - untar `forge-data` into a scratch dir, then
    `git -C …/git/repositories/jumbleknot/mcm.git fsck --connectivity-only`;
  - restore `mc-service-mongo` into a scratch `mongo` with `mongorestore --archive --gzip`, then count
    the collections;
  - delete every scratch container and directory afterwards;
  - add a drill log table: date, snapshot id, durations, counts.
  **Done when**: each block in the section is paste-safe (no secret pasted; bounded waits).
- [ ] T039 [US1] **(operator)** Run the restore drill against the first post-PR-B snapshot, and paste
  the output.
  **Done when**: the forge database restores, `fsck` is clean, and the Mongo collection count is
  above 0. The drill log row is committed (US1-AC5, US4-AC3, SC-005).
- [ ] T040 [US1] Verify item #830's acceptance criteria against T021, T034–T039 and the runbook. Post
  the evidence as a comment with `node scripts/backlog.mjs comment 830 --body-file …`, then close it
  with `update 830 --state closed`. Also close the T021 alert item with a comment linking #830.
  **Done when**: #830 is closed with an evidence comment.

---

## Phase 6: US2: `ci-status` sees a failed deploy (P2), PR C, item #823

**Goal**: the dispatched `cd-deploy` is visible to `status`, `watch` and `failure`, with mergeability
unchanged.

**Independent test**: quickstart US2.

- [ ] T041 [US2] Record fixtures in `scripts/__tests__/fixtures/ci-status/` from the real forge, using
  the `git credential fill` token (reads only):
  - `dispatched-failed.json`: the 2026-10-21 failed cd-deploy run, with its main sha's statuses (none
    for the run);
  - `dispatched-success.json`: a recent successful deploy;
  - `dispatched-in-progress.json`: derived from success, with status `running`;
  - `dispatched-rerun.json`: two runs for one sha, the newer one failed;
  - the `ci-failures/<run_id>` bundle listing for the failed run.

  Strip tokens and emails with the existing `cacheRawPayload` sanitiser.
  **Done when**: the files exist, and `grep -E 'token|@' fixtures/ci-status/dispatched-*` shows no
  secret or email.
- [ ] T042 [P] [US2] Test: in `scripts/__tests__/ci-status.test.mjs`, the **`findDispatchedDeploy`**
  cases (R11, data-model):
  - it selects by `cd-deploy.yml`, `workflow_dispatch` and `head_sha`;
  - the newest run by `id` wins (rerun fixture);
  - in-progress maps to `waiting`, success to `passed`, failure to `failed`;
  - no match returns `null`;
  - `run_number` is never used for the bundle name.
  **Verify RED**: `node --test --test-name-pattern="findDispatchedDeploy" scripts/__tests__/ci-status.test.mjs`.
  Expected: failing, `findDispatchedDeploy is not a function`.
- [ ] T043 [P] [US2] Test: **"status shows the deploy as advisory and the verdict is unchanged"**
  (US2-AC1, AC4, FR-008, FR-012):
  - `computeMergeVerdict` over the failed fixture includes the context
    `cd-deploy / build-deploy (dispatched)`, with `required: false`, in `advisory`;
  - `blocking` and the exit code are identical with and without the deploy context.
  **Verify RED**: `node --test --test-name-pattern="deploy as advisory" scripts/__tests__/ci-status.test.mjs`.
  Expected: failing.
- [ ] T044 [P] [US2] Test: **"watch returns on a failed deploy"** (US2-AC2, FR-009):
  - with required contexts terminal and the deploy `failed`, the watch-loop predicate says *stop* and
    the exit code is **4**, distinct from every value `exitCodeForVerdict` returns (0, 1, 3), which
    the test asserts by enumerating them;
  - with the deploy `waiting`, it says *continue*;
  - with no deploy dispatched for a non-main sha, behaviour is unchanged.
  **Verify RED**: `node --test --test-name-pattern="watch returns on a failed deploy" scripts/__tests__/ci-status.test.mjs`.
  Expected: failing.
- [ ] T045 [P] [US2] Test: **"failure falls back to the deploy's evidence bundle"** (US2-AC3, FR-010,
  FR-011):
  - for the failed fixture with no failed status, the failure output contains the bundle digest for
    `ci-failures/<run_id>`, and never `No failed jobs`;
  - with the bundle listing empty, it prints `deploy run <id> FAILED; no evidence bundle published`
    and exits 1.
  **Verify RED**: `node --test --test-name-pattern="evidence bundle" scripts/__tests__/ci-status.test.mjs`.
  Expected: failing, output `No failed jobs`.
- [ ] T046 [US2] Implement the changes in `scripts/ci-status.mjs`:
  - export `findDispatchedDeploy(sha, runs)`;
  - add the advisory context in the status path, using the existing runs fetch (`buildRunsQuery`) —
    one extra filtered page, not a new endpoint;
  - add the watch stop-predicate and exit code 4;
  - add the bundle fallback in `failure`, reusing `parseBundleGz` and `safeBundleWrite`.
  Add exit code 4 to `--help`, next to the existing meanings of 0, 1 and 3.
  **Verify GREEN**: `node --test scripts/__tests__/ci-status.test.mjs`. All pass. **Mutation (FR-011)**:
  delete the fallback branch, and T045 fails; restore it.
- [ ] T047 [US2] Add to `docs/runbooks/ci-diagnostics.md`: the dispatched-deploy advisory row, exit
  code 4 for `watch`, the bundle fallback, and the case study (2026-10-21).
  **Done when**: the preflight docs checks pass.
- [ ] T048 [US2] Run the PR C gate and open PR C. After it merges, run quickstart US2 against the
  real 2026-10-21 sha and paste the output into the PR. Expected: `failed  run <id>`, and the digest
  is printed.
- [ ] T049 [US2] Verify item #823's criteria, comment the evidence, and close it.

---

## Phase 7: US3: a fixable Critical in an app image fails the PR, not the deploy (P2), PR D, item #822

**Goal**: a required `app-image-scan` check runs the deploy gate's exact pipeline on the six images
PR CI built.

**Independent test**: quickstart US3.

- [ ] T050 [P] [US3] Test: `scripts/__tests__/app-image-scan.test.mjs`, the **drift guard** (FR-014):
  - `scripts/cd/scan-push.sh` and app-ci's `app-image-scan` job both invoke
    `scripts/cd/scan-app-image.sh`;
  - neither contains `trivy`, `infra-image-scan.mjs` or `check-infra-image-findings.mjs` directly;
  - the job's image list equals `scan-push.sh`'s `map` repositories (six names).
  **Verify RED**: `node --test --test-name-pattern="drift" scripts/__tests__/app-image-scan.test.mjs`.
  Expected: failing, because `scan-app-image.sh` is not invoked.
- [ ] T051 [P] [US3] Test: **`scan-app-image.sh` exit meanings** (contract). With a shim `node` on
  `PATH` that answers per script name:
  - scan ok and findings ok: exit 0;
  - scan fails: exit 10 with `SCANNER ERROR`;
  - findings fail: exit 11 with `BLOCKING FINDING` and the image name;
  - no argument, or two: exit 2.
  **Verify RED**: `node --test --test-name-pattern="exit meanings" scripts/__tests__/app-image-scan.test.mjs`.
  Expected: failing, script not found.
- [ ] T052 [P] [US3] Test: **job wiring** (FR-013, FR-016, R12):
  - the `app-image-scan` job exists, with `runs-on: kvm`, `needs` including `changes` and `app-e2e`,
    and `if: always()`;
  - it has an early pass step when `changes.app != 'true'`;
  - it also runs on pushes to `main`, deliberately: there it blocks `trigger-cd` before a deploy is
    dispatched, so a vulnerability-database change shows as a red on `main` rather than as a failed
    deploy;
  - it fails when a `app-scan/<name>:run-${{ github.run_id }}` tag is missing;
  - app-e2e tags all six images with that tag after the agent stack is built;
  - `trigger-cd.needs` includes `app-image-scan`, and its `if` requires `success`;
  - cd-deploy's `scan-push.sh` step is unchanged in position (the deploy gate stays);
  - `REQUIRED_CONTEXT_GLOBS` in `scripts/ci-status.mjs` matches `app-image-scan`;
  - every new `ci-log-step` step name is in `scripts/ci-step-ceilings.tsv`.
  **Verify RED**: `node --test --test-name-pattern="wiring" scripts/__tests__/app-image-scan.test.mjs`.
  Expected: failing, job not found.
- [ ] T053 [US3] Extract `scripts/cd/scan-app-image.sh <local-tag>` from `scan-push.sh`'s loop body,
  moving the comments with it. Make `scan-push.sh` call it, mapping 10 and 11 to its existing two
  messages and `exit 1`.
  **Verify GREEN**: `node --test --test-name-pattern="drift|exit meanings" scripts/__tests__/app-image-scan.test.mjs`.
  All pass. Also `node --test scripts/__tests__/*scan*.test.mjs`, where the existing scan-push guards
  still pass, updated at the cause if they pinned the inline block.
- [ ] T054 [US3] In `.forgejo/workflows/app-ci.yml`:
  - add the app-e2e step `Tag images for app-image-scan` (`ci-log-step` name
    `app-e2e-tag-scan-images`), after the agent stack bring-up;
  - add the `app-image-scan` job (steps: changes short-circuit; verify the six tags; scan each through
    `bash scripts/ci-log-step.sh app-image-scan-<repo> bash scripts/cd/scan-app-image.sh …`; an
    `if: always()` step that removes the tags; publish the failure digest as other jobs do);
  - extend `trigger-cd`.
  Add both step families to `scripts/ci-step-ceilings.tsv` ON THE BACKSTOP, because they have no
  observations yet. Add `app-image-scan*` to `REQUIRED_CONTEXT_GLOBS`, and add
  `scripts/cd/scan-app-image.sh` to the `app` path filter.
  **Verify GREEN**: `node --test scripts/__tests__/app-image-scan.test.mjs scripts/__tests__/ci-status.test.mjs scripts/__tests__/ci-log-step.test.mjs`.
  All pass.
- [ ] T055 [US3] Add to `docs/runbooks/ci-diagnostics.md` what an `app-image-scan` red means (exit 10
  vs 11), the allowlist path, and the PR-green/deploy-red residual. Run the PR D gate and open PR D.
  The PR's own `app-image-scan` must be green and name six images (US3-AC1 and AC2, negative case).
  In PR D's body, record the measured cost behind FR-013's reuse claim:
  - `app-image-scan`'s wall time;
  - app-e2e's `app-e2e-build-images` step from `node scripts/ci-status.mjs durations --job app-e2e`,
    which is what a parallel job would have spent rebuilding.
- [ ] T056 [US3] **Mutation PR (FR-015)**: open a throwaway branch from PR D that re-adds runtime pip
  to `movie-mcp`'s image on the pre-fix base. Do **not** merge it. Expected: `app-image-scan` is red
  with exit 11 naming `movie-mcp` and the CVE, and `app-e2e` is unaffected. Record the run id in PR D,
  then close the throwaway PR and delete its branch.
- [ ] T057 [US3] **(operator)** When merging PR D, add `app-image-scan*` to `main`'s branch-protection
  required checks. Confirm with `node scripts/ci-status.mjs status --sha <PR D head>`, which should
  list it as required.
- [ ] T058 [US3] Verify item #822's criteria, comment the evidence (T055–T057), and close it.

---

## Phase 8: US5: the package registry keeps what is needed (P2), PR E, item #863

**Goal**: a report-only-first retention script that never deletes a deployed, rollback or pinned
digest, and that keeps the `ci-failures` evidence window.

**Independent test**: quickstart US5.

- [ ] T059 [US5] Run quickstart **0g** with the `git credential fill` token: for one `mc-service`
  version, `GET /api/v1/packages/jumbleknot/container/mc-service/<sha>/files`, plus the version list
  pagination (`x-total-count`). Record in research R13 which field carries the manifest digest, and
  the endpoint and verb that delete a version.
  **Done when**: R13's "verify on forge" bullets are answered with the observed payloads, saved as
  fixtures in `scripts/__tests__/fixtures/registry-retention/`.
- [ ] T060 [P] [US5] Test: `scripts/__tests__/registry-retention.test.mjs`, **config validation**
  (data-model). The script refuses:
  - an unknown key;
  - a bad `mode`;
  - a package with neither `keepNewest` nor `keepDays` (and no `keepAll`);
  - a `ci-failures` `keepDays` below `evidenceWindowDays`;
  - a `ci-failures` `keepNewest` below `DEFAULT_DURATION_RUNS` (imported from
    `scripts/ci-status.mjs`) × the number of workflow jobs that publish bundles (counted from
    `.forgejo/workflows/` by the test), so `durations` can always read its full sample.
  **Verify RED**: `node --test --test-name-pattern="config" scripts/__tests__/registry-retention.test.mjs`.
  Expected: failing, module not found.
- [ ] T061 [P] [US5] Test: **protected set from git** (FR-021). In a temp git repo, the fixture writes
  `.env.deploy` files through 7 promotion commits and a `.devcontainer/devcontainer.json` pin. Assert:
  - `protectedDigests()` returns the digests at HEAD plus those at the previous 5 commits touching
    `.env.deploy`;
  - it includes the dev-container pin;
  - it does **not** include the 7th-oldest.
  **Verify RED**: `node --test --test-name-pattern="protected set" scripts/__tests__/registry-retention.test.mjs`.
  Expected: failing.
- [ ] T062 [P] [US5] Test: **decisions** (US5-AC1, AC2, AC3, AC5). Over a version list from the T059
  fixtures:
  - per version, the decision is the first keep reason, else `delete`;
  - deployed and rollback digests older than every window are `keep:protected`;
  - `mcm-app-android` is all `keep:all`;
  - an unconfigured package is all `keep:unconfigured`;
  - `ci-failures` within 45 days is kept.
  **Mutation**: dropping the protected filter turns the protected case red.
  **Verify RED**: `node --test --test-name-pattern="decisions" scripts/__tests__/registry-retention.test.mjs`.
  Expected: failing.
- [ ] T063 [P] [US5] Test: **CLI contract** (FR-023, contract `registry-retention.mjs`):
  - no args gives a report and **zero** DELETE calls (fake `fetch` injected);
  - `--apply` with `mode: report` exits 2 naming the mismatch, with zero DELETEs;
  - `--apply` with `mode: apply` deletes only `delete` rows;
  - an unresolvable protected digest exits 5 with zero DELETEs;
  - `--dry-run`, `--help` and `--package` without a value are rejected with exit 2;
  - `--json` gives valid JSON with per-package totals.
  **Verify RED**: `node --test --test-name-pattern="CLI" scripts/__tests__/registry-retention.test.mjs`.
  Expected: failing.
- [ ] T064 [US5] Implement `scripts/registry-retention.mjs` (config loader, `protectedDigests`,
  decision engine, paginated API client with injectable `fetch`, report and apply) and
  `infrastructure-as-code/forgejo/registry-retention.yaml` with `mode: report` and the R13 values,
  except `ci-failures.keepNewest`. Set that to the floor T060's test computes
  (`DEFAULT_DURATION_RUNS` × the number of jobs that publish bundles), rounded up to the next 50,
  and never below 400.
  **Verify GREEN**: `node --test scripts/__tests__/registry-retention.test.mjs`. All pass.
- [ ] T065 [US5] Add `.forgejo/workflows/registry-retention.yml`:
  - `schedule` weekly, plus `workflow_dispatch` with input `apply` (boolean, default false);
  - checkout with `fetch-depth: 0`, because protection reads git history;
  - run the script, with `--apply` passed **only** when `inputs.apply == true`;
  - write the report to the job summary;
  - token `secrets.REGISTRY_CLEANUP_TOKEN`.
  Add a guard case to `registry-retention.test.mjs`: the schedule trigger can never pass `--apply`,
  and checkout depth is 0.
  **Verify GREEN**: same command; all pass.
- [ ] T066 [US5] Run the PR E gate and open PR E. Document the rule, the protections and the
  report → review → apply flow in `docs/runbooks/Server-Setup-Runbook.md`, in the registry section
  (FR-024).
- [ ] T067 [US5] **(operator)** Create the forge token scoped `write:package` only, and add it as the
  Actions secret `REGISTRY_CLEANUP_TOKEN`.
- [ ] T068 [US5] After PR E merges, dispatch the workflow (report only) and review the report:
  - no `delete` row's digest appears in any `.env.deploy` or in the dev-container pin, which
    `grep` over the JSON confirms;
  - per-package totals, and the bytes that would be freed.
  Post the summary to item #863 (FR-023, first run report-only).
- [ ] T069 [US5] Open a one-line PR flipping `mode: apply`, with the reviewed report linked. After the
  operator approves and it merges, dispatch with `apply: true`.
- [ ] T070 [US5] **(operator)** After the forge's next package-cleanup cron:
  - `du -sh` the package storage, and paste the result;
  - run one normal deploy, and one rollback via `scripts/cd/rollback.sh` on a test promotion, or
    confirm that the prior digest still pulls:
    `docker pull <registry>/jumbleknot/mc-service@<prior digest>`.
  **Done when**: storage is down from 109 G, and the deploy and the rollback pull both succeed
  (US5-AC2, SC-009).
- [ ] T071 [US5] Verify item #863's criteria, comment the evidence, and close it. Note in the comment
  that SC-009's "stops growing month on month" is confirmed by the next month's weekly report totals.

---

## Phase 9: Polish and cross-cutting

- [ ] T072 Merge the spec/plan/tasks branch `084-silent-failure-visibility` (docs only) before or with
  PR A, so every implementation PR cites a merged spec.
- [ ] T073 [P] Run `/speckit-analyze` over spec/plan/tasks, and fix any inconsistency it reports
  before PR A opens.
- [ ] T074 [P] After the last PR, re-run the spec's Measured Baseline queries (Blocks 1–6) and append
  an "After" column to the baseline tables in `spec.md`.
- [ ] T075 Confirm that every SC has evidence linked from its item's closing comment: SC-001..003 and
  SC-005..009 from T021–T071, and SC-004 by observation over the following month (note it in #822).

---

## Dependencies and execution order

```text
T001 ─ T003 ─ T004/T005 ──► US1 (T006–T021) ──► US4 (T022–T037) ──► T038–T040 (drill, close #830)
                                      PR #864 (T023) ─┘
US2 (T041–T049)   independent ─ any time
US3 (T050–T058)   independent ─ any time; T057 lands with the PR D merge
US5 (T059–T071)   independent ─ T067 before T068; T069 needs the reviewed T068 report
T072/T073 before PR A opens; T074/T075 last
```

- **US1 → US4**: the same `backup.sh`, so PR B branches from merged A.
- **US1-AC5 (the drill)** runs after US4, so it proves the format that will actually be kept.
- **US2, US3 and US5** touch disjoint files, except that US3 and US2 both edit
  `scripts/ci-status.mjs`: US3 changes `REQUIRED_CONTEXT_GLOBS` and US2 changes the
  status/watch/failure paths. Rebase whichever merges second; the hunks do not overlap.

## Parallel opportunities

- **Within US1**: the test tasks T006–T012 are separate cases or files, all [P]. T015, T016 and T017
  are [P] once their tests are RED. T013 and T014 are sequential (same file).
- **Within US4**: T024–T028 are [P]; T030 and T031 are [P] alongside T029.
- **Across stories**: C, D and E can be developed in parallel worktrees while A is in review. Mind the
  one ci runner: open them in sequence, not at once (`openwiki/process/pull-request-batching.md`).

## Implementation strategy

1. **MVP = PR A (US1)**: the 3-month blind spot closes the day it is installed (T021). It also
   carries the dump checks, so the size changes in PR B are themselves guarded on arrival.
2. **PR B (US4)** next, because it removes ~20 GiB per night from the NAS and completes #830.
3. **PRs C, D and E** in any order. C first is cheapest, and it makes any D-class deploy failure
   visible meanwhile.
4. Close each item only on verified criteria (forgejo-issues skill), never on merge.
