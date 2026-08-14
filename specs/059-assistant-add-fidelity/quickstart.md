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

## 2. The live-shape check (must be run by hand, at least once)

```bash
# Requires TMDB_API_KEY in mcp-servers/web-api-mcp/.env.local AND outbound egress to
# api.themoviedb.org. Runs against REAL TMDB — never a cassette.
pnpm nx test:integration web-api-mcp -- -k certification
```

**This does not run in CI and does not run in the devcontainer.** web-api-mcp is deliberately not
enrolled in the CI integration step (`app-ci.yml:572`, 048 FR-013), and TMDB egress is blocked in
this container — measured, not assumed:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://api.themoviedb.org/3/   # exit 28, timeout
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 https://registry.npmjs.org/     # 200
```

**A skip here is not a pass.** The suite's conftest skips cleanly when `TMDB_API_KEY` is absent, and
there is no `MCM_REQUIRE_LIVE_*` escalation for it — so an unset key looks identical to success.
Before trusting this section, confirm the key is present and check the skip count is 0.

Run it on a host with egress. If the response shape differs from
[contracts/web-api-mcp-get-movie-details.md](./contracts/web-api-mcp-get-movie-details.md), the
contract is wrong and the unit stub built on it is wrong with it — fix both.

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
- [ ] Section 2 has been run **once** on a host with TMDB egress, with a skip count of 0, and the
      contract matches what TMDB actually returned.
- [ ] Section 3 passes, with the previously-existing tests updated rather than untouched.
- [ ] Section 4 confirmed by hand for both a certified film and an uncertified one.
- [ ] `pnpm nx affected --target=lint,test,typecheck --base=origin/main --head=HEAD` is clean.
- [ ] Items #163 and #162 each carry a comment recording what was corrected in their acceptance
      criteria (the `PG13` rename that does not exist, and the function name that does not exist)
      before either is closed.
