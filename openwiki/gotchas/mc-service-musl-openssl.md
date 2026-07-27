---
type: Gotcha
title: mc-service musl-conditional vendored OpenSSL
description: Why mc-service's Cargo.toml must gate the vendored OpenSSL dependency behind cfg(target_env = "musl") — and why moving it to the unconditional dependencies section silently breaks Windows dev builds.
resource: CLAUDE.md
tags: [rust, docker, musl, openssl, build]
timestamp: 2026-07-06T03:01:34+00:00
---

# mc-service musl-conditional vendored OpenSSL

[mc-service](/openwiki/projects/mc-service.md) is built for production inside `rust:alpine3.21`,
which targets `x86_64-unknown-linux-musl`. Musl links binaries statically (`-static-pie`,
`-Wl,-Bstatic`), but Alpine's `openssl-dev` package only ships dynamic `.so` libraries, not static
`.a` archives — so a normal `cargo build` fails to find `-lssl` on that target.

The fix lives entirely in `backend/mc-service/Cargo.toml`: a
`[target.'cfg(target_env = "musl")'.dependencies]` block adds
`openssl = { version = "0.10", features = ["vendored"] }`. This activates only when the musl
target is selected, pulling in `openssl-src` to compile OpenSSL from C source at build time and
produce static libs. The Dockerfile's build stage installs `perl make` for that compilation step.

## Gotchas

- **Do not move the vendored dependency into the unconditional `[dependencies]` section.** It
  looks like a harmless simplification, but it silently breaks `cargo test` on Windows dev
  machines, which lack `perl` (required to compile OpenSSL from source) and don't need the
  vendored build at all — Windows dev builds use the system/native-tls stack instead.
- **`OPENSSL_VENDORED=1` as an env var does nothing.** The vendored feature must be enabled through
  the Cargo feature flag, not an environment variable — a build that "should" have picked it up via
  env var will fail with the same `cannot find -lssl` error.
- **`OPENSSL_STATIC=1` alone doesn't fix it either** — Alpine simply doesn't have static libs to
  link against without the vendored (compile-from-source) feature.

See [mc-service](/openwiki/projects/mc-service.md) for how this fits into the service's Docker
build overall, and `CLAUDE.md`'s Non-Obvious Design Decisions section for the full narrative.
