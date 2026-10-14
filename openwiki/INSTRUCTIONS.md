# OpenWiki Generation Brief — MovieCollectionManager

This file scopes and constrains wiki generation for this repository. OpenWiki reads it for scope and
priorities; it is **hand-authored and must never be rewritten** by an init, update, or chat run.

Feature 043 governs this bundle. See `specs/043-openwiki-okf/` for the spec, plan, and the
conformance gate that validates the output.

---

## 1. What this wiki is — and what it is NOT

This wiki is a **navigation and gotcha layer** over documentation that already exists. It is not a
second copy of it.

The repository already has high-quality canonical documentation: an architecture overview, fourteen
operator runbooks, architecture decision records, a governing constitution, and per-project READMEs.
The failure mode to avoid is a drifting paraphrase of those documents.

**Therefore, every concept page MUST:**

- Carry a **distilled summary** — what this subject is, in a few sentences.
- Carry the **load-bearing gotchas** — the non-obvious constraints, the traps, the things that cost a
  developer a session when they get them wrong. This is the highest-value content in the page.
- Carry a `resource` link to the **authoritative source**, and defer to it for full detail.

**Every concept page MUST NOT:**

- Reproduce the full text of the document it cites. If a reader needs the whole procedure, the page
  should send them to the runbook, not replay it.
- Restate step-by-step operator procedures. Summarize *what* the procedure achieves and *when* to
  reach for it; link for the *how*.
- Duplicate another concept page. One subject, one page. Link between pages instead of repeating.

A page that is accurate but is really just a copy of its source has failed this brief.

## 2. Exclusions — do not analyze or document these

Skip entirely:

- Dependency and build output: `node_modules/`, `target/`, `dist/`, `build/`, `.venv/`
- Caches and tool state: `.nx/`, `.pnpm-store/`, `.mypy_cache/`, `.ruff_cache/`, `.cargo/`
- Test and coverage artifacts: `coverage/`, `test-results/`, `playwright-report/`, `.maestro/`
- **All environment files**: any `.env`, `.env.*`, `*.env` — no exceptions
- **All secret material**: `secrets/`, `*.key`, `*.pem`, `*.crt`, keystores
- Lockfiles: `pnpm-lock.yaml`, `Cargo.lock`, `uv.lock`, `package-lock.json`
- Binary and generated assets, `.git/` internals

**Also exclude `docs/proposals/**` — deliberately, and this one needs explanation.**

Proposals are *pre-specification ideation*. They are superseded the moment a spec exists, so
documenting them would fill metadata-driven retrieval with dead ideas — the exact opposite of what
this bundle is for. Instead, write **exactly one** page (`type: Process`) describing the
proposal → spec → implementation lifecycle, and link to the folder for humans who want the history.

Note that `docs/runbooks/` contains live operator documents that were *relocated out of* the proposal
tree precisely so this exclusion stays clean. Treat everything in `docs/runbooks/` as in scope.

**Also exclude `docs/test-data/**` — stated here explicitly rather than left to be inferred.**

It holds a binary spreadsheet fixture for a unit test, not documentation: there is nothing to
summarize. It was previously excluded only by accident of the binary-asset rule above, which is not a
declaration. The file stays exactly where it is — its path is baked into a unit test and into feature
014's spec, tasks and quickstart.

**`specs/**` is analyzable but is NOT a coverage target — with one exception.**

Read it freely: for many measured facts a feature's spec, plan or research file is the only record,
and that context makes a concept accurate. But do **not** create a concept per feature. They are
historical work-units superseded by the code they produced, and enumerating them fills
metadata-driven retrieval with dead work.

The exception is `specs/*/HANDOFF.md`. Those carry live measured knowledge — the facts a later session
needs and cannot re-derive cheaply — so they are in scope as sources and may be cited as a `resource`.

**Never rewrite `openwiki/INSTRUCTIONS.md`, `openwiki/policy.yaml`, or `openwiki/protected.yaml`.**

All three are hand-authored and declared `never-written` in the regeneration policy. This file is the
generation brief you are reading. `policy.yaml` declares, per path, when it may be written and which
actor the assignment governs. `protected.yaml` is the protection manifest: it lists the authoritative
concepts and fingerprints the load-bearing passages inside them, so a refresh that reworded one fails
a gate instead of depending on a reviewer noticing. A process must not be able to rewrite the file
that constrains it — that is why the manifest is a YAML sidecar rather than a marker inside the
concept it protects.

## 3. Redaction — non-negotiable

This repository is scanned by automated gates that fail the build on leaked infrastructure topology
or credential-shaped strings. Generated pages are scanned like any other tracked file.

**Never reproduce, even when you encounter it in a source file:**

- Hostnames of the self-hosted forge, the production domain, or any tailnet host or address
- Host+port pairs that identify a real deployment
- Tokens, API keys, passwords, secrets, connection strings with credentials, or anything shaped like one
- Internal IP addresses

**Instead, refer to them abstractly**: "the forge host", "the production domain", "the tailnet
address", "the service account credential". A reader who needs the literal value gets it from the
secrets store, never from a wiki page.

Port *numbers* discussed as a design convention (for example, a reserved range that exists to prevent
collisions) are fine — it is the pairing of a real host with a port that must not appear.

## 4. Priority areas

Generate in roughly this order of value:

**a. Per-project overviews** — one concept per deployable unit, describing its responsibility, its
architectural shape, and its boundaries:

- The Expo/React Native universal app and its BFF (server-side modules, API routes, auth flow)
- The Rust/Axum movie-collection service (its four Clean Architecture layers, CQRS, repository and
  specification patterns)
- The Python LangGraph agent gateway
- The three scoped MCP servers
- The infrastructure-as-code stacks and the CI/CD pipeline

**b. Cross-cutting invariants** — the rules that span projects and are easy to violate:

- The authentication and authorization chain end to end, and where each layer enforces what
- Which model provider is used in which environment, and why that is environment-scoped
- The published-port reservation convention and the collision it exists to prevent
- The secrets-management posture: no clear-text secrets in git, and how the gates enforce it
- The testing tiers and which of them gate a merge

**c. The non-obvious design decisions and operational rules relocated out of `CLAUDE.md`** — highest
value per page. These are decisions where the obvious approach is wrong and the reason is not visible
from the code, plus the measured operational facts that cost a session each when they were rediscovered.
Each deserves its own concept page with the rationale preserved **verbatim** — no abridgement, no
rewording.

**These pages are authoritative and therefore carry NO `resource` field.** Do not cite `CLAUDE.md`:
that file is being reduced to an index and holds none of this content any more, so a citation would
point at a summary of itself. An authoritative concept is the canonical home of its subject, which is
also what makes the routing rule in section 7 decidable. Every authoritative concept must be listed
under `authoritative:` in `openwiki/protected.yaml`; a concept that is neither listed there nor
carrying a resolving `resource` fails the governance gate, because its status would be unknowable.

**d. Runbooks, decision records, and architecture documents** — one concept each, minimum. Every
canonical document under `docs/runbooks/`, `docs/decisions/`, and the architecture documents must be
reachable by a metadata query, so that the *absence* of a concept reliably means "no such document"
rather than "not covered yet".

## 5. Front matter

Every page needs a `type`. Beyond that, populate `title`, `description`, `tags`, `resource`, and
`timestamp` wherever they apply — `description` in particular, since the per-directory `index.md`
navigation is built from it, and a missing description degrades retrieval for everyone.

**A `description` never contains `#`.** The generator ends the `index.md` entry at the first `#`, so
"… reasoning effort of item #525" is listed as "… reasoning effort of item". Name an item in the page body,
or write "item 525" if the description must name it.

Suggested `type` values, kept small and consistent so filtering is predictable:

`Architecture` · `Service` · `Runbook` · `Decision` · `Process` · `Convention` · `Gotcha` · `Reference`

`resource` should point at the authoritative source — a repository-relative path for in-repo
documents (preferred), or a canonical URL for genuinely external references. **Repository-relative
paths are verified to resolve** by the conformance gate, so a link to a moved or renamed file fails
the build; keep them accurate.

**`resource` names one canonical FILE, never a directory.** Drift is judged by the cited source's last
commit, and a directory's last commit is any commit to anything under it. So a page citing a directory
is re-flagged as stale by every unrelated change beneath it, and regenerating it buys nothing durable.
`process/spec-driven-development.md` cited `specs/` and was re-flagged by every new spec; the planner now
reports such a page as *unplannable* rather than paying to regenerate it (feature 082). Cite the
document that states the process or the rule, such as a runbook, the constitution or a template, not
the folder its instances live in.

**`resource` is the field that classifies a page**, so its presence is not cosmetic. A page carrying
one is a *derived summary* of that document. A page carrying none is *authoritative* — canonical in
its own right — and must be listed under `authoritative:` in `openwiki/protected.yaml`. Omitting a
citation you should have made turns a summary into false canon; adding one to genuinely canonical
content points a reader at a document that does not hold the answer. The governance gate rejects a
concept that is neither, and one that is both.

`timestamp` should be ISO 8601. It is compared against the cited source's last modification to report
drift, so an accurate timestamp is what makes staleness visible.

## 6. Links in the body — relative to the file, never to the site root

**Every in-repository link in a page's body MUST be written relative to the file it is written in.**

```markdown
<!-- as written from a page in openwiki/runbooks/ -->
✅  [Spec-driven development](../process/spec-driven-development.md)
✅  [the devcontainer runbook](../../docs/runbooks/devcontainer.md)
❌  [Spec-driven development](/openwiki/process/spec-driven-development.md)
```

The `../` depth therefore depends on where the page lives — a link is correct relative to **its own
file**, not to the bundle root, and rule V15 below checks it from exactly there.

A leading `/` is **not** the repository root. Forgejo resolves it against the **site** root, so
`/openwiki/process/spec-driven-development.md` renders as
`{forge}/openwiki/process/spec-driven-development.md` — which the forge reads as a *username*, and
404s. Measured on Forgejo `15.0.3+gitea-1.22.0` (2026-09-19) with `POST /api/v1/markup`, the one
endpoint that accepts `Context`, `BranchPath` and `FilePath` and so renders a link exactly as the
repository file view does. The relative form resolved to
`{forge}/jumbleknot/mcm/src/branch/main/openwiki/process/…` in the same call.

This cost the bundle **204 dead links across 61 of its 77 files** before anyone checked (item #491),
and it went unnoticed for a specific reason worth internalizing: §5's `resource` paths *were*
verified, and they all passed. Body links were not checked at all, so the bundle looked conformant
while most of its navigation was broken. A navigation layer whose links 404 is worse than no
navigation layer, because the reader trusts it.

Two mechanisms now enforce this, and neither is a reason to write the wrong form:

- `scripts/wiki-maintain.mjs` rewrites a site-root-absolute link to the relative form after every
  slice, deterministically.
- `scripts/check-openwiki-okf.mjs` rule **V14** rejects the form outright, and rule **V15** rejects a
  relative link that does not resolve from its own file's directory. Both fail the build.

Links inside a fenced code block or a code span are exempt — that is how this section is able to
show the wrong form above.

**A link to a section of a SOURCE document targets that document, not its concept page.** A concept
page is a summary and does not carry its source's headings. So `./devcontainer-sandbox.md#4-egress-allowlist`
resolves as a file but its anchor does not, while `../../docs/runbooks/devcontainer-sandbox.md#4-egress-allowlist`
does (proposal #737, `runbooks/sast-scanning.md`). Link a concept page by its file only, and a specific
section through the source document's path.

## 7. Where a new learning goes — the canonical-home rule

This section is for anyone (human or assistant) who has just learned something durable about this
repository and has to decide where to write it. It is **not** about when a path may be regenerated —
that is `openwiki/policy.yaml`. A path can be `regenerate` and still be the correct destination for
hand-written knowledge.

**The rule: a durable learning goes to the canonical home of its subject.** Determine that
mechanically, from the concept covering the subject:

1. Find the concept covering the subject (query by `type`/`tags`, or read the relevant `index.md`).
2. **Does that concept carry a `resource`?**
   - **Yes → the learning goes to the cited source, not to the concept.** The concept is a derived
     summary; write the detail into the runbook, the decision record or the architecture document it
     cites, and leave the summary to refresh from it.
   - **No → the concept is authoritative, and the learning goes into the concept.** There is no
     upstream document to write into; the concept *is* the canonical home.
3. **No concept covers the subject?** Then add one. Where the subject has a canonical document, write
   the detail there and cite it from the new concept. Never append prose to an index instead.

In practice: an operational learning belongs in the runbook, never in the page that summarizes the
runbook. A concept that becomes a copy of its source has failed section 1 of this brief, and
hand-writing into derived summaries is exactly how that failure starts.

The only destinations this changes are the subjects relocated out of `CLAUDE.md`: those concepts are
authoritative, so learnings about them are written **into the concept**. Every other subject keeps the
canonical home it already had.

**Do not write prose into `CLAUDE.md` and expect a later maintenance run to relocate it.** That file
is an index; a check fails on content beyond its index and its machine-managed regions.

### A learning that corrects what is written: rewrite it in place

When a learning shows that a passage is wrong, **rewrite that passage** at its own location so it
states what is true now. Do not leave it and append a "SUPERSEDED", "CORRECTION" or "🚨 CORRECTED by
…" block further down, and do not put a disclaimer at the top that declares later sections
historical. Git holds the history.

- **Keep every measured fact.** A measurement, date, error string, version or item number that
  explains *why* the rule now reads as it does stays in the rewritten passage, as its reason. Only the
  statement of the old, false behaviour goes.
- **A short "was X until <date> (<item, PR or commit>)" note is allowed** only where a reader is still
  likely to meet the old behaviour: a host provisioned before the fix, an old container, a command
  still in someone's shell history.

The reason is the reading order. A reader meets the stale text first, and so does the generator,
which summarises the source in order. It reproduced the superseded, retracted "do not pnpm install
in a worktree" advice into `runbooks/devcontainer-sandbox.md` this way (item #589). Appended
corrections are also the main reason `docs/` used to read as older than this bundle where it was more
current: on 2026-09-27 `ci-diagnostics.md` alone carried 14 of them.

No lint enforces this. The marker words are not a reliable signal: "superseded" is also this
repository's term for a CI run replaced by a newer push, and it appears 18 times in `docs/runbooks/`
for that reason. A lint on the uppercase markers would catch only the wording, and rewording an
appended block passes it. Whether a change rewrote a passage or appended one shows in the diff, so
it is a review question. Revisit if appended corrections reappear after this rule (item #589):
`grep -rn -E "SUPERSEDED|CORRECTION|CORRECTED" docs/runbooks/`.

### The alternative that was rejected, and why

The obvious-looking alternative — keep writing learnings into the instruction file and have a
maintenance run relocate them afterwards — was considered and rejected for two reasons.

First, it requires an automated run to rewrite instruction-file content. The generator's write scope
is deliberately the bundle plus its own managed regions; widening it is a separate decision, not a
convenience, and every assignment in `policy.yaml` rests on that boundary holding.

Second, it reinstates the grow-then-trim cycle this arrangement exists to end. The instruction file
grew to 592 lines and 72 KB once already. A rule that tolerates re-growth on the promise of a later
cleanup produces the same file again, on a slower clock.

## 8. Tone

Write for an engineer or coding agent who is competent but new to this repository. Be direct and
concrete. Prefer the specific detail that prevents a mistake over the general statement that sounds
complete. When a rule exists because something once broke, say so — the reason is what makes the rule
stick.

## 9. Claims evidence — cite what states the fact, never what churns

Every `repo://` citation in a page's Claims is re-resolved before every run. One that moved or
vanished forces the whole page into that run as a mandatory reconciliation — a full paid
regeneration — whatever the run was asked to do. A citation of a file that routine commits rewrite
therefore costs a page regeneration on every such commit, while the fact it supports has not
changed. Runs 4960 and 4972 (2026-10-09/10) each paid for five forced pages this way (item #707).

Do **not** cite, as Claims evidence:

- **Lockfiles** — `uv.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `package-lock.json`. Cite the manifest
  that declares the dependency (`pyproject.toml`, `package.json`, `Cargo.toml`) instead.
- **Image digest or version-pin lines** — `@sha256:` lines in a Dockerfile `FROM` or a compose
  `image:`, and the `infrastructure-as-code/docker/*/.env.deploy` files every CD promotion rewrites.
  Cite the policy or runbook section that says the image is pinned, not the pin.
- **Line ranges inside a list whose entries rotate** — above all `security/sast/allowlist.yaml`,
  whose entries are added and expire. Cite the whole file, or the runbook section that states the
  policy.

Prefer the narrowest **stable** source: a heading-level section of a runbook over a line range of a
script that is under active change. `node scripts/wiki-maintain.mjs --claims-audit` lists, offline,
every page openwiki will force into the next run and marks the citations that are churn.

## 10. Never copy live state into a page

`openwiki/.maintenance-state.json`, `.page-manifest.json`, `.last-update.json`, `.run.json` and the
`.claims/` sidecars are **live state**: the next run rewrites them. Describe what their fields mean
and where to read them, but do not copy current values into a page: a backlog, an `escalations`
entry, a `lastOutcome`, a cost or a call count. A copied value is wrong by the next run, and a page
that quotes it looks authoritative while it is stale. Proposal #737 published "after the 2026-10-11
runs it holds `lastOutcome: failed` … `failuresAtLow: 2` … ~$1.69" in `runbooks/wiki-maintenance.md`,
a snapshot that was already false when proposed. A measured value that explains *why* a rule exists
belongs in the source runbook, dated, with its run number, and the page may cite it from there.

