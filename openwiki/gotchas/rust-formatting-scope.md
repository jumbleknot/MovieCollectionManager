---
type: Gotcha
title: cargo fmt formats the WHOLE crate — a per-file argument does not scope it
description: Why `cargo fmt -- <file>` reformats every file in the crate rather than the one named, why that is a manufactured diff and not a harmless tidy-up in a repository with pre-existing drift, and the single-file alternative.
tags: [rust, cargo, rustfmt, mc-service, tooling, formatting]
timestamp: 2026-08-09T00:00:00+00:00
---

# cargo fmt formats the WHOLE crate — a per-file argument does not scope it

## The trap

This looks like it formats one file. It does not:

```bash
cargo fmt --manifest-path backend/mc-service/Cargo.toml -- backend/mc-service/tests/http_authz_test.rs
```

Everything after `--` is passed to **rustfmt**, but `cargo fmt` still hands rustfmt the **crate
root**. rustfmt then walks the whole module tree from there, so every file in the crate is
reformatted. The named path adds a target; it does not restrict one.

**To format a single file, invoke rustfmt directly:**

```bash
rustfmt backend/mc-service/tests/http_authz_test.rs
```

## Why this is worse here than it sounds

On a clean crate a whole-crate format is a harmless tidy-up. In `backend/mc-service` it is not, and
the reason is context that has to travel with the rule or the rule reads as pedantry:

- **`cargo fmt --check` already drifts in 7 untouched files** on clean `main`. A whole-crate format
  therefore rewrites 7 files nobody in your change has looked at.
- **The lint gate is the Nx target — `pnpm nx lint mc-service` — not `cargo clippy --all-targets`.**
  `--all-targets` reports **9 pre-existing failures** on clean `main`, so it is not a signal about
  your change. Judge a change by whether it adds diagnostics *naming its own files*.
- So the convention is **format only what you touch**. A whole-crate format produces a diff that
  someone must then prove is unrelated to the change, in a review where the interesting part is
  three files.

**Measured, 2026-08-02, during feature 046.** The per-file invocation above reformatted the whole
crate, including 4 of those drift files under `src/`. That silently broke a task precondition
requiring an empty `src/` diff. Recovery was `git checkout --` against every file the feature did not
own, leaving only the two it did, then re-confirming `src/` was empty.

## Recovery

If it has already happened, do not try to re-format selectively — restore instead, then format the
files you actually own:

```bash
git checkout -- backend/mc-service/src            # discard the unrelated reformatting
git diff --stat backend/mc-service                 # confirm only your files remain
rustfmt backend/mc-service/tests/<your-file>.rs    # then format just yours
```

## Related

Dependency resolution in the dev container needs `cargo --offline`, and a *failing* `--offline`
resolve is itself a signal — see
[the devcontainer runbook](/docs/runbooks/devcontainer.md), which is where that half lives.

See also [mc-service musl-conditional vendored OpenSSL](/openwiki/gotchas/mc-service-musl-openssl.md)
and [mc-service](/openwiki/projects/mc-service.md).
