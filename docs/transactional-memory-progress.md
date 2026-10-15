# Transactional memory progress

## Goal and scope

Keep original messages authoritative, prevent incomplete JSONL writes or summaries from hiding them, and make typed compactor policy refusals terminal per node until an explicit retry. No compactor or `index.ts` changes are included here.

## Implemented

- A terminating newline is the JSONL commit marker. Readers ignore an unterminated tail; the next append truncates to the last complete record. Failed appends attempt to restore the previous file length.
- Startup loads tree summaries in dependency order and ignores invalid, duplicate, empty, out-of-range, or source-incomplete summaries. Original entries remain available.
- Only a thrown value carrying `error.code === 'OPTCHAT_POLICY_REFUSAL'` blocks a node. Its warning and `lastError` use fixed sanitized text; the block survives normal appends, which continue to clear retry delays for ordinary failures. Successful summary text mentioning policy is unaffected.
- `FileStore` persists small `terminal`/`retry` events in the tree JSONL log: node level/index and the refusal code only; no raw error text or summary content is copied into these records. Startup folds these events in order. `Memory.retryRefused(part)` is the explicit reset-and-retry API and persists its retry event before scheduling.
- Stores without the optional `appendTerminal` capability retain suppression only for the current process and warn that the node can be retried after reopening.
- A `tree` wait rejects promptly when a terminal refusal makes a complete tree impossible. An `ahead` wait rejects only when a refusal remains and no active, scheduled, or timed retry work can free its slot; ordinary turn waits still return with missing-ready nodes as before.

## Integration boundary

This memory work does not edit `index.ts`. The parent has separately wired `/optchat retry-summary <start>+<size>` to `Memory.retryRefused(part)` as an explicit user action. It does not switch providers or retry automatically.

## Verification

- `node --import tsx --test test/memory.test.ts`: 48 passed, including bounded refusal waits for both `tree` and `ahead`, refusal sanitization, append/reopen suppression, explicit retry, and successful summaries containing policy language.
- `node --import tsx --test test/import.test.ts`: 38 passed, covering import integration; `node --import tsx --test test/store.test.ts`: 8 passed, including crash-interrupted JSONL recovery.
- Strict source-only TypeScript check for `src/memory.ts` and `src/store.ts`: passed; `git diff --check` passed.
- `settle` no longer introduces a complexity gate after extracting its refusal-block predicate. Project-wide `ripwire --quality-delta` still exits 2 with 12 short-horizon-churn gates across the shared worktree; no refactoring was done to game churn. `ripwire --test-gate` cannot infer a runner and reports broader untested scope; the focused tests above were executed directly.
- The full suite is intentionally not run while parallel edits continue. Earlier broad failures were in unrelated inspector/operational-state/report-message tests; that result predates this terminal-refusal work.

## Next integration step

The parent owns the user-facing `/optchat retry-summary <start>+<size>` hook. Until a user explicitly invokes it, blocked nodes remain preserved and suppressed, including after reopening with `FileStore`.

## Parent UI integration evidence

`/optchat retry-summary <start>+<size>` is wired to the explicit retry API. The real Pi headless slash-command test observes a frozen node, invokes the command, sees the retry record and valid activated summary, and proves no main-request resend or configured model/provider/effort change. Tree/ahead terminal waits reject promptly; default turn waits preserve existing behavior. Final OptChat full suite passes (383 pass, one skip), strict project typecheck passes, compatibility 2/2 passes.
