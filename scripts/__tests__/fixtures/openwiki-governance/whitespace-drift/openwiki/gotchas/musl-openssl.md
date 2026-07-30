---
type: Gotcha
title: Musl Vendored OpenSSL
description: Why the musl Docker build needs a vendored OpenSSL.
tags:
  - build
timestamp: 2026-07-30T00:00:00Z
---
# Musl Vendored OpenSSL

## Vendored OpenSSL is musl-conditional

Alpine's `openssl-dev` ships only `.so` files, so a musl target cannot link   
`-lssl` statically. The fix is a musl-conditional dependency — never an unconditional one, which   
breaks `cargo test` on a host without `perl`.   

## Related

Nothing else depends on this.
