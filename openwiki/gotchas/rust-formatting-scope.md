---
type: Gotcha
title: cargo fmt formats the WHOLE crate — a per-file argument does not scope it
description: Why `cargo fmt -- <file>` reformats every file in the crate rather than the one named, the single-file alternative, and why — since spec 095 made `cargo fmt --check` part of the lint gate — it now only bites on a branch cut before that.
tags: [rust, cargo, rustfmt, mc-service, tooling, formatting]
timestamp: 2026-11-08T00:00:00+00:00
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

## Why it matters less than it did — and when it still bites

Until 2026-11-08 `cargo fmt --check` drifted in several untouched mc-service files on clean `main`,
and nothing enforced the constitution's "`cargo fmt` enforced in CI/CD". A whole-crate format
therefore rewrote files nobody in the change had looked at, and the convention became "format only
what you touch". That cost one feature its task precondition (feature 046, 2026-08-02: the per-file
invocation reformatted 4 drift files under `src/` and broke a required-empty `src/` diff).

**Spec 095 removed the drift and made the check a gate.** `pnpm nx lint mc-service` now runs
`cargo fmt -p mc-service --check` before clippy, so `main` is format-clean by construction and a
whole-crate `cargo fmt` on a fresh branch changes only what you changed. Format freely.

It still bites on a branch cut **before** spec 095 merged, or when rebasing one across it: there,
a whole-crate format rewrites the drift the old base still carries. Merge `main` first.

The lint gate is the Nx target, `pnpm nx lint mc-service` (fmt check, then
`clippy --all-targets -D warnings`), and it is clean on `main` — judge a change by it.

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
[the devcontainer runbook](../../docs/runbooks/devcontainer.md), which is where that half lives.

See also [mc-service musl-conditional vendored OpenSSL](./mc-service-musl-openssl.md)
and [mc-service](../projects/mc-service.md).
