# ADR-0003 — Grounded Claims and Protected-Passage Fingerprints Are Complements

**Status**: Superseded in part by [ADR-0004](ADR-0004-session-maintained-wiki.md) (Claims on derived pages). The fingerprint half stands.
**Date**: 2026-11-01
**Feature**: none. A governance decision recorded under item #513
**Deciders**: Steven Watson
**Supersedes / relates to**: item #513 (this decision); the operator decision of 2026-09-27 that Claims are required and valuable; feature 044 (wiki maintenance) and its FR-026c (`actor: generator` only under `openwiki/`); FR-029b and FR-041 (the protection manifest and its fingerprints); items #611 and #616 (V16, the Claims durability check); [wiki-maintenance runbook §9](../runbooks/wiki-maintenance.md).

---

## 1. Decision

**Grounded Claims and the fingerprints in `openwiki/protected.yaml` are complements with disjoint
scopes. Neither supersedes the other.**

- **Claims** live on **derived** pages only: a concept citing a `resource`, written by the generator.
- **Fingerprints** live on **authoritative** pages only: a concept listed under `authoritative:`
  in `protected.yaml`, with no upstream document.
- **No page is both.** The governance gate enforces this as **G13**.

---

## 2. Measured before deciding (origin/main, 2026-11-01)

| | Count |
|---|---|
| Claims sidecars under `openwiki/.claims/` | 43, each with its page and a `.page-manifest.json` entry; 43 manifest entries in all |
| Pages carrying `verified:` with no sidecar | 0 |
| Sidecars with no page | 0 |
| Authoritative pages in `protected.yaml` | 22, with fingerprinted passages in 21 |
| Authoritative pages with a sidecar | **0** |

The two sets were already disjoint: 43 pages covered by Claims, all derived; 22 protected pages, all
authoritative; 17 derived pages with neither.

The disjointness is enforced by policy, not by luck. In `openwiki/policy.yaml`, every authoritative
page is `event-driven, actor: agent`, and `actor: generator` is permitted only under `openwiki/`
(G3). So the generator never writes an authoritative page, and Claims, which only the generator
writes, cannot attach to one. G11 already requires every concept to be exactly one of derived or
authoritative.

---

## 3. Why complements: they answer different questions

| | `protected.yaml` fingerprint | Grounded Claim |
|---|---|---|
| Protects | **prose we wrote**, byte-exact | **a fact the generator wrote**, with its evidence |
| Fails when | the passage changes without a reviewed fingerprint update | the cited evidence changes (`stale`) or cannot be read (`unresolved`) |
| Response | a human updates the text and its fingerprint together | the generator confirms, revises or retracts the claim on the next refresh |
| Applies to | authoritative pages (no upstream source) | derived pages (an upstream source exists) |

Swapping either mechanism into the other's scope would defeat it:
- A Claim on an authoritative page would have nothing to cite but the page itself.
- A fingerprint on a derived page would fail every legitimate refresh, the very thing a derived page
  exists to receive. G7 already rejects that.

### Rejected: Claims supersede fingerprints

Making Claims supersede fingerprints for some pages would convert those authoritative pages into
derived ones. Each would need an upstream document to derive from, which by definition does not
exist yet: the text would first have to move into a canonical source, with the concept citing it.
That is a content migration, so it needs a spec, not a policy edit. No measured problem calls for
it.

---

## 4. Consequences

1. **G13 (`okf-governance`)**, implemented by `claimsScopeFindings` in
   `scripts/openwiki-claims.mjs`, fails:
   - an authoritative page with a Claims sidecar or a `.page-manifest.json` entry;
   - a sidecar with no page;
   - a page carrying `verified:` with no sidecar.

   V16 continues to check that a covered page's bytes match the `pageVersion` its sidecar certifies.
   Today the disjointness holds only through policy. G13 makes a future openwiki that writes Claims
   for pages it did not generate fail a PR, rather than silently becoming a second, conflicting
   protection.
2. **Declared scope.** `openwiki/.claims/**` and `openwiki/.page-manifest.json` get their own
   `regenerate, actor: generator` entries in `policy.yaml` instead of inheriting from the catch-all.
3. **V12 drift stays.** For pages covered by Claims, the evidence recheck is the richer signal. For
   the derived pages without Claims, V12 is the only drift signal.
4. **Operating guidance** for a failed evidence recheck (`stale` vs `unresolved`, and how to uncover
   a page before a hand edit) is in the [wiki-maintenance runbook §9](../runbooks/wiki-maintenance.md).

## 5. Re-check

Revisit when an openwiki release changes where Claims are written, for example Claims on pages it
did not generate, or evidence that may cite the page itself. G13 is what will surface the first
case.
