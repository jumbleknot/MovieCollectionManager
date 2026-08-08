# Quickstart & validation — Forgejo issue tracking

**Feature**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Research**: [research.md](research.md)

A run guide, not an implementation guide. Everything below is runnable from inside the dev container
except step 1, which is an operator action on the host and in the forge UI.

Every command's output is host-redacted by the tool itself, so these are safe to paste into a session.

---

## 1. Credential — already provisioned; nothing to do

`MCM_FORGE_ISSUE_TOKEN` is set in this container and reads successfully today (research D5). Its
permissions are repository-read plus item-write, and it is **deliberately not restricted to this
repository** — the operator's decision of 2026-08-08, which supersedes the source PRD's single-repo bot
requirement. There is no bot to create, no token to re-mint, and no setup step blocking anything below.

Two things follow, and both matter more than a setup checklist:

- **Do not try to check the scopes by reading `permissions`.** The repository payload's
  `{admin, push, pull}` block describes what the owning *account* may do with the repository, not what
  the token may do. An item-write-only token on an admin account reports `admin: true` and still cannot
  push a commit. No endpoint this token can reach reports its own scopes, so the scope split is proven
  behaviourally, in step 5, or not at all.
- **The client-side guard is the blast-radius bound.** Because the credential can reach items on other
  repositories, every write refuses unless it targets the repository the working copy points at
  (FR-016) — not only the task fan-out. That guard is worth a test of its own, and it is the one line
  of defence that a mistyped owner/repo cannot get past.

If the credential ever needs replacing: `setx MCM_FORGE_ISSUE_TOKEN <value>` on the host, then **fully
quit VS Code** — a window reload is not enough, because the reused process keeps its old environment and
`${localEnv}` resolves to empty, so the token goes silently absent rather than failing loudly. Then
rebuild the container.

---

## 2. Unit tier — offline, token-free, deterministic

```bash
node --test scripts/__tests__/backlog.test.mjs
```

This is also how CI runs it: the guardrails `naming` job shell-expands
`node --test scripts/__tests__/*.test.mjs`, so the new file is enrolled automatically with no workflow
edit. Watch the **count**, not the exit status — a suite that collected 0 tests exits 0.

---

## 3. Read tier — verifiable before any write credential exists

```bash
node scripts/backlog.mjs list --state all            # must NOT list pull requests
node scripts/backlog.mjs list --state all --json
node scripts/backlog.mjs show 29                     # Renovate's Dependency Dashboard
node scripts/backlog.mjs ready
```

Expected:

- `list` shows backlog items only. Today that is item #29 alone. If pull requests appear, `type=issues`
  was dropped — the 1-row-vs-143-row trap (research D2).
- Any truncated listing prints the authoritative total from `x-total-count`, never a row count.
- `ready` excludes #29 once it carries `status/bot-managed` (step 4).
- No output line contains the forge host; it reads `<forge>`.
- With `MCM_FORGE_ISSUE_TOKEN` deliberately unset for one invocation
  (`env -u MCM_FORGE_ISSUE_TOKEN node scripts/backlog.mjs list`), reads still succeed via
  `MCM_FORGE_TOKEN` and any write attempt names the missing variable (FR-005).

---

## 4. Setup of conventions (one-time, writes)

```bash
node scripts/backlog.mjs setup-labels --dry-run          # what would be created; writes nothing
node scripts/backlog.mjs setup-labels                    # 0 labels exist today, so all 10 are created
node scripts/backlog.mjs setup-labels                    # again: reports all present, creates nothing
node scripts/backlog.mjs setup-milestone 049-forgejo-issue-tracking
node scripts/backlog.mjs update 29 --add-label status/bot-managed
```

Both `setup-*` commands are idempotent and never overwrite an existing label's colour or description —
the operator may have adjusted those in the web UI. `setup-milestone` is not optional housekeeping:
`resolveNames` refuses an unknown milestone name, and with zero milestones defined every `--milestone`
value is unknown until something creates one.

Then commit `.forgejo/issue_template/backlog-item.yaml` and, **after it reaches the default branch**,
validate it with the forge's own validator:

```bash
node scripts/backlog.mjs validate-form
```

Expected: valid. The template only takes effect from the default branch, so this cannot pass from the
feature branch — a property of the forge, not a failure (research D8), which the command states in its
output rather than leaving you to conclude the form is broken.

---

## 5. Write tier — the one-time live verification (both halves)

Run in order. The **negative half is not optional**: without it the scope split is asserted, not proven.

```bash
printf 'Context\n...\n' > /tmp/item.md

node scripts/backlog.mjs create --title 'Probe: write path verification' \
  --body-file /tmp/item.md --label type/chore --label priority/p3     # expect 201 + a number

node scripts/backlog.mjs comment <n> --body-file /tmp/item.md          # expect 201
node scripts/backlog.mjs create --title 'Probe: blocker' --body-file /tmp/item.md \
  --label type/chore --label priority/p3
node scripts/backlog.mjs dep <n> --blocked-by <m>                      # expect 201
node scripts/backlog.mjs update <n> --state closed                     # expect REFUSAL: blocked
node scripts/backlog.mjs dep <n> --blocked-by <m> --remove             # expect 200
node scripts/backlog.mjs update <n> --state closed                     # expect 200, now closed
node scripts/backlog.mjs update <m> --state closed
```

Then the negative half — the same writes under the read-only token must fail:

```bash
MCM_FORGE_ISSUE_TOKEN=$MCM_FORGE_TOKEN \
  node scripts/backlog.mjs create --title 'Probe: must 403' --body-file /tmp/item.md \
  --label type/chore --label priority/p3
```

Expected: **403**, reported as a named token + missing scope, with the explicit note that this is
granular scope rather than expiry — and no item created.

Capture the blocked-close response verbatim while you are here; it becomes the fixture for
`classifyUpdateFailure` (research, open risk 2), whose shape is currently unobserved.

While the taxonomy now exists, re-measure the positive label-filter behaviour that could not be
established with zero labels defined (FR-017):

```bash
node scripts/backlog.mjs list --state all --label type/chore     # must return ONLY chore items
node scripts/backlog.mjs list --state all --label no-such-label  # must FAIL validation, not return everything
```

The second command is the guard against the measured API behaviour: `labels=<unknown>` is silently
ignored server-side and returns the unfiltered set (research D3).

---

## 6. Acceptance exercise (US6 / SC-006)

Paste the workstation backlog into a session and ask the assistant to file every entry. Then:

```bash
node scripts/backlog.mjs list --state open
node scripts/backlog.mjs ready
```

Expected: one item per entry, each with a type and a priority label and the four body sections; entries
too large to implement directly carry `status/needs-spec`; the operator reviews and corrects the set in
the web UI in a single pass; nothing is dropped or duplicated. Calibrate the taxonomy against what
actually showed up (research D9/OQ-2) — that calibration is the deliverable of this step, alongside the
migrated backlog itself.

Finally, confirm the property the whole feature rests on:

```bash
git status --short && git log --oneline -1     # unchanged by every command above
```

No commit, no branch, no pull request, no pipeline run resulted from any backlog operation (FR-002,
SC-002).
