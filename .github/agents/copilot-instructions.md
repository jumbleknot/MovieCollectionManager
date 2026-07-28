# MovieCollectionManager Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-05-02

## Active Technologies



## Project Structure

```text
backend/
frontend/
tests/
```

## Commands

# Add commands for 

## Code Style

General: Follow standard conventions

## Recent Changes



<!-- MANUAL ADDITIONS START -->

## Knowledge Wiki (OKF) — check this before searching broadly

This repository carries a structured, agent-facing knowledge wiki at `openwiki/`, in the Open
Knowledge Format: one markdown file per concept, each with YAML front matter (`type`, `title`,
`description`, `tags`, `resource`, `timestamp`) and a per-directory `index.md`.

**Query the front matter by `type` and `tags` before falling back to a broad text search.** Each
concept is a distilled summary plus the load-bearing gotchas, and links to the authoritative source
via its `resource` field — follow that link for full detail rather than trusting a summary.

Coverage is complete for the canonical documentation: every runbook, architecture decision record,
and architecture document has at least one concept citing it, so the absence of a concept means the
document does not exist rather than that it is not yet covered.

`openwiki/` is generated. Do not hand-edit pages under it — fix the source document or the generation
brief at `openwiki/INSTRUCTIONS.md` and regenerate with
`pnpm nx wiki-update infrastructure-as-code`.

<!-- MANUAL ADDITIONS END -->
