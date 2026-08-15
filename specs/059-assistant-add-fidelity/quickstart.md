# Quickstart — validating 059 assistant add fidelity

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md)

Run these in order. Each section says what a pass proves and — more importantly — what a pass does
**not** prove, because two of the three tiers here can report success without exercising the change.

---

## 1. Merge-blocking tiers (run these on every change)

```bash
# The certification extraction — every row of contracts/web-api-mcp-get-movie-details.md
pnpm nx test web-api-mcp

# The payload values, the stage machine, and the answer surviving the approval pause
pnpm nx test movie-assistant

# Both linters — a tier you did not think of is a tier that did not run
pnpm nx lint web-api-mcp
pnpm nx lint movie-assistant
```

**Proves**: the mapping is right for a certified film, a film with no US entry, an empty string, an
unrecognised value and a multi-entry film; `to_movie_payload` emits `"rated": null` rather than
`"NR"`; the children's answer reaches the payload for every ownership branch; the new stage is
registered everywhere it must be.

**Does not prove**: that TMDB's real response has the shape the stub asserts. The transport is
stubbed here by design (§Test Type Integrity permits it at the unit tier only) — section 2 is the
only check of the live shape.

**Watch the counts, not the colour.** A `k`-filtered run that collects 0 tests exits 0. Confirm the
new tests actually ran:

```bash
pnpm nx test web-api-mcp -- -k certification -v   # expect the new cases listed, not "no tests ran"
```

---

## 2. The live-shape check (real TMDB — runs here and in CI)

```bash
pnpm nx test:integration web-api-mcp
```

**Proves**: the response shape the stub in section 1 is built on is the shape TMDB actually returns,
and "The Secret Life of Pets 2" (2019) resolves to `PG` from the source itself.

This runs **in this dev container** and **in CI** — it is not a hand-run step. TMDB is on the
dev-container allowlist (`.devcontainer/init-firewall.sh`) and web-api-mcp is enrolled in CI's
integration step with skip-escalation. If it stops working, diagnose in this order:

```bash
# 1. Is the allowlist entry live? (401 = connected; 000/timeout = stale ipset or lost entry)
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://api.themoviedb.org/3/

# 2. Stale CDN IPs are the usual cause — re-resolve, don't widen the allowlist
sudo env FORGE_REGISTRY_HOST="$FORGE_REGISTRY_HOST" /bin/bash .devcontainer/init-firewall.sh

# 3. The allowlist verifier checks TMDB and that default-deny still holds
bash .devcontainer/verify/verify-firewall-allowlist.sh
```

**A skip here is not a pass.** The suite's conftest skips cleanly when `TMDB_API_KEY` is absent, so
an unset key looks exactly like success. Check the skip count is 0 locally; in CI the escalation
turns that skip into a failure.

**A green here is not proof it called anything, either.** The suite is fast (5 passed in 0.79 s),
which is a shape a no-op also has. The control that settles it, if you ever doubt a green:

```bash
cd mcp-servers/web-api-mcp && uv run python -c "
import asyncio; from src.tools import make_tmdb_client, get_movie_details
key=[l.split('=',1)[1].strip() for l in open('.env.local') if l.startswith('TMDB_API_KEY=')][0]
async def m():
    async with make_tmdb_client(key,'https://example.com/3') as c:
        await get_movie_details(c,'tmdb:412117')   # MUST raise ConnectTimeout
asyncio.run(m())"
```

If the live shape ever differs from
[contracts/web-api-mcp-get-movie-details.md](./contracts/web-api-mcp-get-movie-details.md), the
contract is wrong **and** the unit stub built on it is wrong with it — fix both, never just the test.

---

## 3. End-to-end flow (non-blocking tier)

```bash
# Full agent stack required (E2E_AGENT_PRODUCTION=1, a TMDB key, the model provider).
node scripts/agent-e2e.mjs agent-add-ownership
node scripts/agent-e2e.mjs agent-add-external-link
```

**Proves**: the children's question is asked first from both a search card and a typed add; the
created movie carries the member's answer and the film's real rating; abandoning adds nothing; and —
SC-001, the reported case — "The Secret Life of Pets 2" (2019) lands as `PG`.

**Tier reality**: every test in these files is `@model-decision`, which does **not** block a merge.
That is deliberate (the flow needs the model to choose tools), and it is why nothing deterministic
was left here.

**Expect existing tests to change.** Five tests in `agent-add-ownership.spec.ts` and one in
`agent-add-external-link.spec.ts` walk a fixed turn sequence starting at the ownership question. The
extra question shifts that sequence; if they pass unmodified, the new question is not being asked.

---

## 4. Manual confirmation of the reported defect

The bug was found by a member, and the fix should be confirmed the same way:

1. Bring the local stack up (`docs/runbooks/local-dev.md`) and sign in.
2. Ask the assistant to add **"The Secret Life of Pets 2"** to a collection.
3. Expect the children's-movie question **before** "Do you own this?", answer it either way.
4. Approve the add and open the movie's detail screen.
5. **Rated reads `PG`.** Before this feature it read `NR`.
6. Repeat with a film that has no US certification: Rated is blank, and the add still succeeded.

---

## Definition of done for this feature

- [ ] Section 1 passes, with the new test cases visibly collected (not zero-collected).
- [ ] Section 2 passes here with a skip count of 0, **and** the CI integration step runs
      web-api-mcp — confirmed in the run log, not assumed from the workflow edit.
- [ ] Section 3 passes, with the previously-existing tests updated rather than untouched.
- [ ] Section 4 confirmed by hand for both a certified film and an uncertified one.
- [ ] `pnpm nx affected --target=lint,test,typecheck --base=origin/main --head=HEAD` is clean.
- [ ] Items #163 and #162 each carry a comment recording what was corrected in their acceptance
      criteria (the `PG13` rename that does not exist, and the function name that does not exist)
      before either is closed.
