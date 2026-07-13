# MCM Maintainability Hardening

- Naming a module after a requirement ID hurts readability and AI comprehension.  Notice the asymmetry in `/utils/fr009.ts`: the functions are well-named (isAutoNavDone, markAutoNavDone, clearAutoNav) and the JSDoc explains the behavior — but the filename fr009.ts tells you nothing without cross-referencing the spec. The principle: identifiers should describe behavior; requirement IDs belong in a comment/JSDoc for traceability (which it already has). A reader (or AI) seeing import { markAutoNavDone } from '@/utils/fr009' has to go look up FR-009; from '@/utils/default-collection-nav' is self-documenting.  Let's do a repo-wide cleanup of naming files or modules after requirement IDs and validate all tests green.
- Propose an addition to the constitution to ensure going forward that: identifiers should describe behavior; requirement IDs belong in a comment/JSDoc for traceability
- Then let's do a detailed code review (`/code-review ultra`)
