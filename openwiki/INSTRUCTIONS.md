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

**c. The non-obvious design decisions currently trapped in `CLAUDE.md`** — highest value per page.
These are decisions where the obvious approach is wrong and the reason is not visible from the code.
Each deserves its own concept page with the rationale preserved. Cite `CLAUDE.md` as the resource.

**d. Runbooks, decision records, and architecture documents** — one concept each, minimum. Every
canonical document under `docs/runbooks/`, `docs/decisions/`, and the architecture documents must be
reachable by a metadata query, so that the *absence* of a concept reliably means "no such document"
rather than "not covered yet".

## 5. Front matter

Every page needs a `type`. Beyond that, populate `title`, `description`, `tags`, `resource`, and
`timestamp` wherever they apply — `description` in particular, since the per-directory `index.md`
navigation is built from it, and a missing description degrades retrieval for everyone.

Suggested `type` values, kept small and consistent so filtering is predictable:

`Architecture` · `Service` · `Runbook` · `Decision` · `Process` · `Convention` · `Gotcha` · `Reference`

`resource` should point at the authoritative source — a repository-relative path for in-repo
documents (preferred), or a canonical URL for genuinely external references. **Repository-relative
paths are verified to resolve** by the conformance gate, so a link to a moved or renamed file fails
the build; keep them accurate.

`timestamp` should be ISO 8601. It is compared against the cited source's last modification to report
drift, so an accurate timestamp is what makes staleness visible.

## 6. Tone

Write for an engineer or coding agent who is competent but new to this repository. Be direct and
concrete. Prefer the specific detail that prevents a mistake over the general statement that sounds
complete. When a rule exists because something once broke, say so — the reason is what makes the rule
stick.
