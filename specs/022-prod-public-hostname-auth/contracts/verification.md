# Contract: End-to-end verification (Part D)

Maps to spec Success Criteria. Items 1–4 are automatable; 5–7 are operator/manual.

| # | Check | Success criterion | Type |
|---|---|---|---|
| 1 | Both secret gates + naming gate pass for all new files | SC-005 | automated (CI) |
| 2 | `docker compose config` fail-fasts on a missing required var for each prod compose | SC-006 | automated |
| 3 | Existing web E2E (Playwright) login + BFF cookie unit tests stay green | SC-001 (web), session | automated (regression) |
| 4 | Discovery doc at `https://auth.${BASE_DOMAIN}/.../openid-configuration` reports the public issuer | SC-002 | automated probe (post-deploy) |
| 5 | Admin console not reachable on the public `auth.` host; reachable only on the tailnet | SC-004 | operator |
| 6 | Only `mcm.` and `auth.` respond from the public internet; all else unreachable | SC-003 | operator |
| 7 | Off-network device login (cellular, no LAN): full OAuth round-trip → protected screen | SC-001 (mobile) | manual device E2E |

## Notes

- Item 7 is the headline acceptance and is **manual** (real device on a non-home network), per the constitution's E2E-on-real-device rule and the spec Assumptions.
- Items 4–7 require the operator deploy steps (Komodo Stacks, Cloudflare published routes, real secret injection) that are **out of repo scope** — they are listed here so the feature's "done" state is unambiguous, not because this feature automates them.
- Session refresh (SC-007) and brute-force lockout (SC-008) are exercised during item 7 / a focused login probe.
