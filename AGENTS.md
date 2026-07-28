<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

# General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax


<!-- nx configuration end-->

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->

<!-- The block above is maintained by the OpenWiki tool and is rewritten on every run. The section
     below is hand-authored, lives OUTSIDE that block, and therefore survives regeneration. It is
     the shared pointer for the assistants that read this file (OpenCode, Codex). -->

## Knowledge wiki (OKF) — repository-specific notes

**Query `openwiki/` before falling back to a broad text search.** Every concept file carries YAML
front matter (`type`, `title`, `description`, `tags`, `resource`, `timestamp`) and each directory has
an `index.md`, so you can select concepts by kind and topic instead of grepping. A concept is a
distilled summary plus the load-bearing gotchas; follow its `resource` link for authoritative detail
rather than trusting the summary.

Coverage is complete for the canonical documentation — every runbook, architecture decision record,
and architecture document has at least one concept citing it. So a missing concept means the document
does not exist, not that it is not yet covered.

Two corrections to the generated block above, which describes OpenWiki's defaults rather than this
repository:

- **There is no scheduled workflow refreshing this wiki.** CI here runs on a self-hosted Forgejo
  instance under `.forgejo/workflows/`, not GitHub Actions, and feature 043 deliberately deferred
  scheduled regeneration. Freshness is a manual step in the Final Validation Checklist:
  `pnpm nx wiki-update infrastructure-as-code`.
- **Always regenerate through that Nx target, never the bare `openwiki` CLI** — the target sets
  `OPENWIKI_TELEMETRY_DISABLED=1`, and the tool reports usage telemetry by default.

Do not hand-edit pages under `openwiki/`: they are regenerated. Fix the source document, or the
generation brief at `openwiki/INSTRUCTIONS.md`, and regenerate. A page rejected by the conformance
gate (`pnpm nx okf-lint infrastructure-as-code`) or by a leak scan is fixed in that brief — never by
adding an allowlist entry.
