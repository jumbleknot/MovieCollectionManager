---
type: Runbook
title: Local Development Stack
description: Summary of the local stack bring-up order.
resource: docs/runbooks/local-dev.md
timestamp: 2026-07-30T00:00:00Z
---
# Local Development Stack

## Vendored OpenSSL is musl-conditional

Alpine's `openssl-dev` ships only `.so` files, so a musl target cannot link
`-lssl` statically. The fix is a musl-conditional dependency — never an unconditional one, which
breaks `cargo test` on a host without `perl`.

See the linked runbook for the full procedure.
