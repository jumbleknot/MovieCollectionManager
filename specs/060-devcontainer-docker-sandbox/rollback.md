# Rollback record — 060-devcontainer-docker-sandbox

**Governing**: FR-033 — every migration phase MUST have a rollback that restores the previous
working state, and the existing environment MUST remain untouched until adoption.

This file starts with the **egress-allowlist extraction (T007/T008)** because that is the first
change in this feature that modifies a file the *current working environment executes on every
start*. Everything before it was additive (new files) or documentation. T058 extends this file with
one entry per migration phase.

Read the emergency path first. It is the one you will want at the moment you least want to be
reading documentation.

---

## 🚨 Emergency: egress is broken and you need it back NOW

From inside the dev container:

```bash
sudo iptables -P OUTPUT ACCEPT
```

That restores egress immediately by flipping the default policy, without unwinding anything else.
It is **deliberately not a fix** — it disables the default-deny posture until the next container
start (or the next `init-firewall.sh` run) reinstates it. Use it to unblock yourself while you
prepare the real revert below, and to complete a cold registry pull, which is its other documented
use.

Confirm which layer actually refused the request before reverting anything. Under the sandbox
topology there are **two** enforcement layers and they fail identically from inside:

```powershell
sbx policy log        # FIRST — the host-side sandbox policy, if you are on the sandbox path
```

```bash
sudo ipset list allowed-domains | head    # THEN — the in-VM ipset, for staleness
```

A CDN-backed destination (`cdnRotating: true` in `.devcontainer/egress-allowlist.json`) that times
out mid-session is almost always a **stale ipset**, not a missing rule. Re-running
`init-firewall.sh` re-resolves it. Do not "fix" that by widening the allowlist.

---

## P2 — Egress allowlist extraction (T004 – T008)

### What changed

| Change | File | Risk |
| --- | --- | --- |
| Canonical destination list added | `.devcontainer/egress-allowlist.json` | none — new file, no consumer until the change below |
| Generator added | `scripts/gen-egress-policy.mjs` | none — new file |
| Contract test added | `.devcontainer/verify/verify-egress-allowlist-contract.sh` | none — new file |
| **Inline `ALLOWED_DOMAINS` array replaced by a read of the generator** | `.devcontainer/init-firewall.sh` | **this is the risky one** |
| Header scope/limits paragraph corrected | `.devcontainer/init-firewall.sh` | none — comments only |

### Why this one is risky

`.devcontainer/init-firewall.sh` runs **as root on every start of the dev container**, wired to
`postStartCommand`. A failure here does not break some future environment — it degrades the egress
of the environment you are working in right now, on its next start. The specific failure modes are:

1. **`node` not on root's PATH under `sudo`.** The hook invokes
   `sudo env FORGE_REGISTRY_HOST=… /bin/bash …/init-firewall.sh`, and `sudo` resets the environment
   to its `secure_path`. Verified present at `/usr/local/bin/node` on the current image, and
   `/usr/local/bin` is in the default `secure_path` — but a base-image change could move it.
2. **Generator crash or malformed JSON**, yielding an empty domain list.

Both are handled by **failing closed before any iptables call**: the script now aborts with a
`FATAL` message if the generator is missing, if `node` is absent, if the generator exits non-zero,
or if the resolved list is empty. The domain read sits *before* the reset section, so an abort
leaves the existing ruleset untouched rather than half-applied.

The failure mode this guards against is the dangerous one: an empty allowlist combined with
`iptables -P OUTPUT DROP` is a **total egress blackout** that presents as a network fault rather
than as a bug in this script.

### Revert procedure

**Revert commit**: **`8f991b40`** — `feat(060): derive the egress allowlist from one canonical list`.

It touches **exactly one file** (`.devcontainer/init-firewall.sh`, +77/−84) and was deliberately
committed on its own for this reason: the revert is surgical and cannot disturb anything else. The
additive files live in the preceding commit `d997f1f9` and have no other consumer.

```bash
# 1. Restore the previous init-firewall.sh (this alone is enough to restore behaviour).
git revert --no-commit 8f991b40
#    or, to revert ONLY the risky file and keep the new additive files:
git checkout 8f991b40^ -- .devcontainer/init-firewall.sh

# 2. Re-apply the restored firewall immediately, in the running container.
sudo env FORGE_REGISTRY_HOST=$FORGE_REGISTRY_HOST /bin/bash .devcontainer/init-firewall.sh

# 3. Confirm the restore actually took effect — do not assume it did.
bash .devcontainer/verify/verify-firewall-allowlist.sh
```

The second form is preferred while the migration is in flight: `egress-allowlist.json`,
`gen-egress-policy.mjs` and `verify-egress-allowlist-contract.sh` have **no other consumer**, so
leaving them in place is harmless and avoids re-doing T004–T006. Only `init-firewall.sh` needs to
go back.

### What is NOT affected

- The Docker Desktop `devcontainer.json` is unmodified by this phase.
- No named volume, cache or credential is touched.
- The change is behaviour-neutral **and was proven so twice, before and after applying it**:
  - *Before* — the generator's domain set diffed against the committed inline array: **set-identical,
    28/28, empty diff**. Checked before the script ever touched iptables.
  - *After* — applied in the DinD dev container from a cleared ruleset with the exact
    `postStartCommand` invocation: exit 0, **179** ipset entries against the original's **178** (one
    IP, DNS A-record variance), and `verify-firewall-allowlist.sh` passing 7/7 with `example.com`
    still refused.
  - `mcr.microsoft.com` is the one destination the generator emits that the inline array did not.
    It is an **addition**, not a drift: reverting this commit reverts to the 28, and the web-E2E
    image pull then depends on a warm cache again.

---

## Phases P1 and P3 – P6

Extended by **T058** once each phase has actually been performed. Recording a rollback for a phase
that has not run yet would be a claim, not a procedure. The intended shape, from
[quickstart.md](quickstart.md):

| Phase | Rollback | Status |
| --- | --- | --- |
| P1 sandbox bring-up | `sbx rm mcm` | to be recorded at T058 |
| P2 egress + forge gate | reset policy to the bring-up profile; `sbx rm mcm` | partially recorded above (in-repo half) |
| P3 dev container | `docker rm -f` the container in the VM; re-run `devcontainer up`; Docker Desktop config untouched | to be recorded at T058 |
| P4 editor chain | remove the managed `Host *.sbx` block; drop the published SSH port | to be recorded at T058 |
| P5 workload | `down-mcm` / `down-auth` in the VM, or `sbx rm mcm` | to be recorded at T058 |
| P6 adopt | `git revert` — **the only irreversible step**, see below | to be recorded at T058 |

**The asymmetry to record honestly at T058**: P6 step 5 is the only irreversible step, because it
deletes the fallback configuration. Before it, rollback is reverting documentation commits and the
environment is unaffected. After it, rollback restores the nested-engine configuration from history
— and that configuration must be **rebuilt and verified before being relied on**, because a
configuration unexercised for a fortnight is a claim, not a fallback.
