# Task 3 Report: Scaffold Copy from Seed + registerWorkspace

## Implementation Summary

Successfully implemented the scaffold copy functionality and `registerWorkspace` following TDD methodology as specified in task-3-brief.md.

### What Was Implemented

1. **New Exports in `server/workspace.ts`:**
   - `SEED_KEY = 'workspace_seed_path'` constant
   - `getSeedPath(): string` - returns seed path from settings or default
   - `ensureWorkspaceScaffold(workspacePath: string)` - copies BMAD, CLAUDE.md, and enforcement hook from seed
   - `registerWorkspace(path: string)` - registers workspace path, un-declines it, and scaffolds

2. **Test Coverage in `server/workspace.test.ts`:**
   - `makeSeed()` helper function to create test seed directories
   - Two tests for `ensureWorkspaceScaffold`:
     - Verifies successful copy of all three pieces (bmad, claude-md, hook)
     - Verifies idempotency (no re-copy on second run)
     - Verifies `seedMissing: true` when seed lacks `_bmad`
   - One test for `registerWorkspace`:
     - Verifies path registration, deduplication, and scaffolding
     - Verifies un-declining of previously declined paths

### Test Results

**Workspace tests only:**
```
npx vitest run server/workspace.test.ts
✓ server/workspace.test.ts (12 tests passed)
Duration: 201ms
```

**Full test suite:**
```
npm test
✓ 27 test files passed (207 tests)
Duration: 948ms
```

### Key Implementation Details

1. **Seed validation:** Returns `{ created: [], seedMissing: true }` if seed lacks `_bmad` directory
2. **Idempotency:** Each scaffold piece checks for existence before copying
3. **Settings.json creation:** Hook copy also writes `.claude/settings.json` if missing
4. **Path normalization:** All paths resolved and expandHome applied for tilde support
5. **Un-declining:** `registerWorkspace` removes path from declined list if present
6. **Deduplication:** Multiple calls to `registerWorkspace` with same path only add once

### Deviations from Brief

None. Implementation follows the brief exactly with all specified signatures, return types, and behavior.

### Self-Review Notes

✅ All tests green (workspace + full suite)
✅ TDD cycle followed (red → green → commit)
✅ Exact signatures and constants from brief
✅ Reused existing helpers (`writeJsonArray`, `expandHome`, `getWorkspaces`)
✅ Extended fs imports as specified (`cpSync`, `writeFileSync`)
✅ No YAGNI violations - implemented only what was specified
✅ Tests clean up temp directories in finally blocks
✅ Code style matches existing module conventions

## Commit

- **Hash:** `ab44b20`
- **Message:** `feat(workspace): scaffold copy from seed + registerWorkspace`
- **Files:** `server/workspace.ts`, `server/workspace.test.ts`
- **Changes:** +141 insertions, -3 deletions

---

## Code Review Fixes (2026-07-16)

Successfully fixed three findings from code review using TDD methodology.

### FINDING A: settings.json unconditional-if-absent (spec violation)

**Problem:** `.claude/settings.json` was only written INSIDE the hook-copy block, so workspaces with an existing hook but missing settings.json never got settings.json. Global Constraint required: "settings.json written only if absent" — independent of hook status.

**Fix:** Pulled settings.json write out of the hook block. Now checks `existsSync(settingsPath)` independently and writes whenever absent, creating `.claude` directory first with `recursive: true`. Hook status no longer gates settings.json creation.

**Test:** Added `'writes settings.json even when hook already exists (FINDING A)'` test that pre-populates workspace with hook but no settings.json, then verifies settings.json gets written and hook is not in created list.

### FINDING B: incomplete seed crash guard

**Problem:** Seed validation only checked for `_bmad` existence. If seed had `_bmad` but no `.claude/hooks/user-prompt-submit.sh`, the `cpSync` of the hook threw ENOENT mid-scaffold, crashing the function.

**Fix:** Guarded hook copy with `existsSync(seedHookPath)` before copying. If seed hook is missing, skip the hook piece (don't add 'hook' to created-list, don't crash). Also added defensive guard for `.claude/skills` copy since it's in the same bmad branch.

**Test:** Added `'handles incomplete seed with _bmad but no hook (FINDING B)'` test that creates a seed with only `_bmad` directory (no hook), verifies scaffold succeeds, 'bmad' is in created list, 'hook' is not, and hook file doesn't exist in workspace.

### FINDING C: test gap - un-decline verification

**Problem:** The `registerWorkspace` test claimed to verify un-declining but never actually declined the path first, so it wasn't testing the un-decline code path.

**Fix:** Added dedicated test `'un-declines a previously declined path'` that calls `declineWorkspace(ws)` before `registerWorkspace(ws)`, then asserts that `isDeclinedPath(ws)` returns false and the declined list does not contain the resolved path.

### Test Results

**Workspace tests:**
```
npx vitest run server/workspace.test.ts
✓ 15 tests passed (was 12, now 15)
Duration: 223ms
```

**Full test suite:**
```
npm test
✓ 27 test files passed (210 tests, was 207)
Duration: 823ms
```

### Changes Summary

- **File:** `server/workspace.ts`
  - Pulled settings.json write out of hook block to run unconditionally when absent
  - Added `existsSync` guard for seed hook path before copying
  - Added `existsSync` guard for seed skills path before copying
  
- **File:** `server/workspace.test.ts`
  - Added 3 new tests (FINDING A, FINDING B, FINDING C coverage)
  - All existing tests remain green

### Confirmation

✅ FINDING A addressed: settings.json writes unconditionally when absent, independent of hook status
✅ FINDING B addressed: incomplete seed (missing hook) no longer crashes, skip gracefully with exists check
✅ FINDING C addressed: un-decline test now actually declines first and verifies removal from declined list
✅ All workspace tests pass (15/15)
✅ All tests pass (210/210)
✅ TDD methodology followed (test first for new coverage, then fix, verify green)
