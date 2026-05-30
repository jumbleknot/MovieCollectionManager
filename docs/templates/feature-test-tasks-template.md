# Template: Feature Test Tasks

**Usage**: Copy this template when writing `tasks.md` for any new feature. Replace all `[placeholder]` values. Delete sections that do not apply (e.g., documentation tasks do not have a RED/GREEN cycle).

This template is referenced from `frontend/mcm-app/CLAUDE.md` — do not move it.

---

## Template: Test Task (with TDD checkpoint)

Use this format for every task that writes or modifies a test.

```markdown
### T[NNN] — [Task title in imperative form]

**Type**: [Test | Test refactor | New file] | **Time**: [estimate] | **Risk**: [None | Low | Medium | High]

**Spec reference**: [spec.md#user-story-N] (which acceptance scenarios this task covers)

**Scenarios covered**:
- US[N]-AC[N]: [Acceptance criterion text from spec.md]
- US[N]-AC[N]: [...]

**File(s)**: `path/to/test/file.spec.ts`

[Description of what the test does — which behavior it verifies, what selectors/assertions it uses, any setup it requires.]

**Verify RED** (run this before implementing — test must fail):
```bash
[exact command to run the test in isolation]
```
**Expected RED**: [N] test(s) failing — `[expected failure message or assertion error]`

> If this command shows 0 failures, the test is trivially passing and must be fixed before implementation begins. A passing test that was never RED is not a TDD test.
```

---

## Template: Paired Implementation Task

Every test task must have a corresponding implementation task immediately after it.

```markdown
### T[NNN+1] — [Implementation title — mirrors the test task]

**Type**: Implementation | **Time**: [estimate] | **Risk**: [None | Low | Medium | High]

**Spec reference**: [same as the paired test task]

**Prerequisite**: T[NNN] must be complete and verified RED.

[Description of what to implement — specific files, functions, API calls, or configuration changes.]

**Verify GREEN** (run this after implementing — test must pass):
```bash
[same command as the test task's Verify RED command]
```
**Expected GREEN**: 0 failures — `[summary line, e.g., "5 passed"]`

**Also run full suite:**
```bash
pnpm nx e2e mcm-app   # or pnpm nx test mcm-app for unit tasks
```
**Expected**: All previously passing tests still pass.
```

---

## Template: Documentation / Config Task (no RED/GREEN cycle)

Use this format for tasks that write documentation, update config files, or create non-test infrastructure.

```markdown
### T[NNN] — [Task title]

**Type**: [Documentation | Config change | Utility script] | **Time**: [estimate] | **Risk**: None

**Spec reference**: [FR-NNN] or [SC-NNN]

[Description of what to do — specific sections to add, config keys to set, or files to create.]

**Done when**: [Concrete observable condition that confirms the task is complete.]
```

---

## Template: Platform Parity Table

Add one of these to every feature's `tasks.md`. Include it before the Completion Checklist.

```markdown
## Platform Parity Table

| Scenario | Web (Playwright) | Mobile (Maestro) | Status |
|---|---|---|---|
| US1-AC1: [scenario description] | `auth.spec.ts` | `login.yaml` | ✅ |
| US1-AC2: [scenario description] | `auth.spec.ts` | N/A — [justification] | N/A |
| US2-AC1: [scenario description] | `movies.spec.ts` | `movie-add.yaml` | ✅ |
| US2-AC2: [scenario description] | `movies.spec.ts` | [create: movie-edit.yaml] | ❌ Gap |
```

**Column definitions:**

- **Scenario**: `US[N]-AC[N]: [brief description]` — must map to an acceptance criterion in spec.md
- **Web (Playwright)**: filename of the Playwright spec, or `N/A` with justification
- **Mobile (Maestro)**: filename of the Maestro flow, or `N/A` with justification, or `[create: filename.yaml]` if the gap needs a new flow
- **Status**: `✅` (both platforms covered), `N/A` (gap is justified), or `❌ Gap` (gap needs resolution — create a task for it)

**N/A justification examples** (must be written, not implicit):
- `N/A — registration is web-only (no native registration screen in mobile app)`
- `N/A — web routing behavior only (auto-redirect uses browser URL; not applicable to React Native navigator)`
- `N/A — mobile uses native layout without a column visibility toggle`

Every `❌ Gap` must have a corresponding task in the task list (typically in Phase 6 or equivalent).

---

## Template: Completion Checklist

Add at the end of every `tasks.md`.

```markdown
## Completion Checklist

Before marking `[NNN]-[feature-name]` complete, verify all success criteria from [spec.md](spec.md):

- [ ] **SC-001**: [Success criterion text]
- [ ] **SC-002**: [Success criterion text]
- [ ] Platform parity table is complete — no ❌ gaps remain unresolved
- [ ] All test tasks used the TDD checkpoint format (Verify RED confirmed before implementation)
- [ ] `pnpm nx test mcm-app` — unit tests pass (≥70% line coverage)
- [ ] `pnpm nx test:integration mcm-app` — integration tests pass
- [ ] `pnpm nx e2e mcm-app` — web E2E passes
- [ ] `pnpm nx e2e:mobile mcm-app` — mobile E2E passes
- [ ] `pnpm nx lint mcm-app` — no lint errors
- [ ] `rtk gain` — >80% token compression confirmed
```

---

## Full example: test task pair

The following shows a complete test task + implementation task pair. Use this as a reference when writing new tasks.

---

### T007 — Write filter-by-contentType test

**Type**: Test | **Time**: 30 min | **Risk**: None

**Spec reference**: spec.md#user-story-1

**Scenarios covered**:
- US1-AC2: When the contentType filter is applied, only movies of that type are displayed
- US1-AC3: The displayed count matches the expected number of fixture movies with that contentType

**File**: `tests/e2e/web/movies.spec.ts`

Add a test that navigates to the BROWSE fixture collection, applies the contentType = "Movie" filter, and asserts the exact expected row count from `FIXTURE_MOVIES`.

```typescript
import { FIXTURE_MOVIES, FIXTURE_COLLECTIONS } from '../../fixtures/base-dataset';

test('filters movies by contentType', async ({ page }) => {
  await page.goto(`/collections/${FIXTURE_COLLECTIONS.BROWSE}`);
  await page.getByLabel('Content Type').selectOption('Movie');
  const expected = FIXTURE_MOVIES.filter(m => m.contentType === 'Movie').length; // 5
  await expect(page.getByRole('row', { name: /data-row/ })).toHaveCount(expected);
});
```

**Verify RED**:
```bash
pnpm exec playwright test tests/e2e/web/movies.spec.ts --grep "filters movies by contentType"
```
**Expected RED**: 1 test failing — `Error: Locator expected to have count 5 but had 0` (filter is not yet implemented).

> If this shows 0 failures, the filter may already be implemented or the locator is wrong. Fix before proceeding.

---

### T008 — Implement contentType filter in movies screen

**Type**: Implementation | **Time**: 2 hrs | **Risk**: Low

**Spec reference**: spec.md#user-story-1

**Prerequisite**: T007 must be complete and verified RED.

Add the contentType filter control to the collections screen. Connect it to the existing `GET /bff-api/collections/{id}/movies?contentType=Movie` query parameter that mc-service already supports.

**Verify GREEN**:
```bash
pnpm exec playwright test tests/e2e/web/movies.spec.ts --grep "filters movies by contentType"
```
**Expected GREEN**: 1 test passing — `1 passed (1.2s)`.

**Also run full suite:**
```bash
pnpm nx e2e mcm-app
```
**Expected**: All previously passing tests still pass.

---

## Rules for using this template

1. **Verify RED is mandatory** — run the Verify RED command and confirm the expected failure before starting implementation. If the test passes before implementation, stop and fix the test.

2. **Exact failure output** — write the expected RED output specifically enough that an unexpected failure message is immediately visible. "1 test failing" is not enough; include the assertion error text.

3. **Isolation first** — the Verify RED and GREEN commands must be isolated (single test or single file), not the full suite. The full suite is for the Final Validation Checklist only.

4. **N/A justifications must be written** — never leave a parity table cell blank. Either fill it or write an explicit N/A justification.

5. **Documentation tasks skip RED/GREEN** — tasks that only modify CLAUDE.md, tasks.md, spec.md, or config files do not have a TDD cycle. Use the documentation task format instead.
