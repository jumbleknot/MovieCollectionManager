# Quickstart: verifying Python toolchain grouping

**Feature**: 067-python-toolchain-grouping | **Date**: 2026-09-07

Five checks. The first two run in seconds and gate the merge; the third is the one that would
otherwise be taken on trust; the fourth is the real proof of the interpreter move; the fifth is CI.

> ⚠️ **`node --test <file> --test-name-pattern "x"` silently runs EVERYTHING** — everything after the
> script path becomes the script's own `argv`. Put node's flags **before** the path, or use `--test`
> with a glob. A Verify RED filtered this way turns into "all green" while filtering nothing.

---

## 1. The guard test — the merge gate

```bash
node --test scripts/__tests__/renovate-workflow.guard.test.mjs
```

Expected: all pass, **and the count of tests goes up** relative to `main`. A guard suite that passes
with the same number of tests has not gained the assertions this feature is for.

CI runs it as `guardrails / naming`, via `node --test scripts/__tests__/*.test.mjs`.

### Prove each new assertion actually fails (the Verify RED that matters)

Each of these must produce a **failure naming the disagreement**, then be reverted:

| break this | expect this to fail |
|---|---|
| set `.python-version` to `3.15`, leave the ceiling | the ceiling assertion (INV-2) |
| change one `FROM python:3.14-slim` to `3.13-slim` | the on-disk tag/pin assertion (INV-1), naming that file |
| move the `python toolchain` rule after `docker digest pins` | the `digest` → `docker digest pins` assertion (C1/C4) |
| delete the `python toolchain` rule | the group assertions for both `pyenv` and `dockerfile` (INV-4) |

The third row is the one worth doing by hand at least once — it is the failure mode the whole
ordering constraint exists for, and it is invisible to every other check.

---

## 2. The config validator

```bash
npx --yes --package renovate@44 -- renovate-config-validator --strict --no-global renovate.json
```

**Both flags are load-bearing.** Without `--no-global` the file is validated as a *global* self-hosted
config rather than the repo config Renovate actually reads; without `--strict` a needed migration is
a warning and the run exits 0. Measured on this repository (runbook §9): a `fileMatch`-style mutation
passes without them and fails with them.

---

## 3. The resolved-rule reality check

Config resolution modelled by a test is still a model. Confirm against the real bot:

```bash
# renovate 44 in a scratch dir, then, from the repo root:
RENOVATE_PLATFORM=local RENOVATE_DRY_RUN=lookup LOG_LEVEL=debug \
  node <scratch>/node_modules/renovate/dist/renovate.js > /tmp/lookup.log 2>&1

grep -o '"branchName": "renovate/[a-z0-9.-]*"' /tmp/lookup.log | sort | uniq -c | sort -rn | head
```

Expected after the move, with the ceiling at `<3.15` and nothing newer published: no
`renovate/python-toolchain` branch at all, because the pin, the tags and the ceiling agree and there
is nothing to propose. To see the group work, raise the ceiling to `<3.16` **temporarily** and re-run;
the eight `minor` updates should appear on `renovate/python-toolchain` while the `digest` updates stay
on `renovate/docker-digest-pins`.

> ⚠️ **Restore `renovate.json` from a backup afterwards and confirm with
> `git status --porcelain renovate.json`.** This probe edits a tracked file that gates every PR.

---

## 4. The interpreter move — the real re-lock proof

This is what makes "no re-lock needed" a measurement rather than a claim. `uv sync --frozen` is
defined as *do not update the lockfile; error if it is out of date*, so a build that passes under it
proves the existing lock resolves on the new interpreter.

```bash
pnpm nx up-agents-prod      # builds all four images (scripts/agent-stack.mjs lines 54-57)
```

Expected: all four images build. Then confirm the locks were genuinely used, not bypassed —
`uv sync` should report a package count, e.g. `Installed 44 packages`, in each build's output.

> ⚠️ **Do not use `docker build -q` to check this.** It suppresses the output, leaving exit 0 as the
> only evidence, which cannot distinguish "uv resolved 44 packages" from "a cached layer replayed".
> Use `--progress=plain`, and `--no-cache` if the layers are already warm.

> ⚠️ **Bind mounts do not work in this dev container** — a `-v` source resolves on the sandbox VM, and
> a missing one is created empty (item #382). Build from a context directory instead of mounting one.

Confirm afterwards that no lockfile moved:

```bash
git status --porcelain '**/uv.lock'    # must be empty (FR-012)
```

---

## 5. CI

`app-ci` is the authority: it runs the same four image builds on the runner, then the agent E2E
tiers. A green `guardrails / naming` plus `guardrails / renovate-config` plus `app-ci` is the
merge condition.

Remember the repository's own warning: **a skipped test reads as a pass.** Check the skip count, not
just the absence of red.

---

## What "done" looks like

| | |
|---|---|
| `.python-version` | `3.14` |
| 8 × `FROM python:` | `3.14-slim@sha256:<one identical digest>` |
| ceiling | `<3.15` |
| 4 × `requires-python` | `>=3.13`, **unchanged** |
| 4 × `uv.lock` | **unchanged** |
| runbook §8 python row | grouped: yes — `python toolchain` |
