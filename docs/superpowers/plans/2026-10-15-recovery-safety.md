# OptChat Recovery Safety Implementation Plan

**Goal:** Implement the seven approved recovery improvements without paid test inference or external publication.

**Architecture:** Preserve append-only originals; harden existing memory, routing, and budgeting paths. Add bounded durable operational/operation records where narrative memory cannot safely carry state. Policy refusals are terminal for automatic recovery, not permission to switch providers.

**Tech stack:** TypeScript, Pi 1.2 extension events, node:test, existing file stores.

## Acceptance and evidence

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| 1. Single-owner, bounded recovery | Not verified (integration gate pending) | PMA agent b271ba0f implemented arbiter, refusal latch, governor accounting, native abort, safe root events. Independent reviewer ffb7212b found lost parent lease on nested B failure; owner reproduced and fixed with a three-account continueBlocks regression. Final full PMA suite/package check and re-review pending. Ready-account/manual routing preserved. |
| 2. Transactional compaction | Verified offline for FileStore | JSONL newline is commit marker; child process exits 73 before summary newline, reopen rejects partial node, next append cannot promote it; original log unchanged. Tree nodes require valid complete source ranges/children. Typed policy refusal persists across append/reopen. Memory 48, import 38, store 8 focused tests pass. Terminal tree/ahead waits reject instead of hanging. |
| 3. Structured operational state | Verified offline | Bounded explicit records with provenance and supersession. Authorizations/constraints must quote the full direct, non-imported user source. State is not an authority source. Self-report-only evidence cannot make a verified check. Unit/tool and real Pi update/inspect/context tests pass. |
| 4. Uncertain external effects | Verified offline | Durable intent before actual synthetic effect; interrupted Pi leaves uncertain intent, reopened Pi blocks mutation, permits trusted read-only observation, and requires evidence reconciliation. Error/write-failure race and legal reused tool IDs regressions pass. Recorded response is never verified external success. Main/children share journal. |
| 5. Whole-request budget | Verified as a heuristic, not exact tokenizer | Main/child and compactor account for system, tool schemas, messages, memory/state, and output reserve. Oversized first compactor request sends zero provider calls; oversized correction sends only the initial fitting call. No source trimming/cache-prefix changes or savings claim. |
| 6. Fault/replay suite | Not verified (final PMA gate pending) | OptChat interruption, process-exit/torn-write, refusal, stream/retry, request-overflow, stale/reused IDs and persistence tests pass. PMA mixed-chain bounds/nested failover regression final gate pending. No paid test calls. |
| 7. Correlated, privacy-safe diagnostics | Verified downstream offline; PMA final gate pending | Real Pi fixture emits root recovery event; recovery JSONL, 8 post-event compactor snapshots, usage ledger and operation records share root UUID/session. Per-compaction attempt UUID remains separate. Strict metadata projection and per-model/role failure counts tested. PMA emitter registered-hook tests supplied by separate lane, final suite pending. No provider-quota attribution inferred. |

## Current integration verification
- `npm run check`: passed.
- `npm test`: **383 passed, 0 failed, 1 skipped** (384 total).
- `npm run test:pi-compat`: **2/2 passed**.
- `git diff --check`: passed (line-ending warnings only).
- `npm pack --dry-run --json`: package contains all six checked recovery/state/budget modules (51 files total); no archive published.
- Ripwire edit checks: no incompatible callers in parent-owned APIs. Quality delta exits 2 on **14 short-horizon-churn gates only** after removing the actual complexity/duplication regressions introduced in this task. Test gate exits 4, listing 48 test files and 19 untested impacted symbols; static runner inference is unavailable. These gates have not been suppressed or represented as clean.

## Integration fixes caught by checks/review
- Provider call IDs can be reused on a fresh assistant turn: journal now includes source session entry identity, with a response-to-intent map. Existing report delivery regression reproduced before the fix, passes afterward.
- Failed response persistence must remove in-flight exemption immediately: filesystem failure regression verifies other sessions block before settle.
- Unrelated valid source ID cannot launder fabricated permission: exact full-source quote required.
- Recovery JSONL must stay out of memory Git checkpoints even with custom ignore files: regression failed before exclusion and passed after.
- Recovery event unsubscribe belongs in existing shutdown lifecycle: duplicate-hook Pi compatibility failure reproduced, consolidated without weakening assertion, 2/2 passed afterward.
- `/optchat retry-summary <start>+<size>` exposes explicit retry without main-request resubmission/provider changes; real Pi slash-command test passes.

## Ownership
- PMA: b271ba0f; independent reviewer ffb7212b.
- Memory/store: ec95e861.
- Request budgeting/compactor: 31c3ab9a.
- State module: ffb7212b (before read-only PMA review).
- Diagnostics/usage: 65680728.
- Real Pi interruption/correlation fixture: acdcfe8c.
- Parent integration/operations/commands/docs; independent operation/provenance review 1a2ccfcc.

## Scope and pending activation
Native `0xC0000409` remains unexplained and is not established as fixed. Custom stores lacking optional terminal-record persistence warn that suppression cannot survive reopen. This is not distributed exactly-once execution or a sandbox: installed read-only declarations are trusted, remote APIs need idempotency keys, and evidence references remain agent/operator assertions. User manual terminal commands bypass tool hooks.

The configured packages already point to `C:/projetos/pi-optchat/worktrees/shell-panel` and `C:/projetos/pi-multi-account`. Changes are local source, not activated in the current session; `/reload` is pending after agents/checks finish. Active-account routing and stored Haiku medium effort are unchanged. Preserve existing `.ripwire_quality_baseline` in PMA. No commit/push/merge/release/deployment authorized or performed.

## Useful upstream updates integrated (current follow-up)

Reviewed upstream/main at 924e61f (five commits beyond the common history). Ported source/tests without creating commits:
- 34676aa (#179): memory view budgets include UTF-8 labels, separators and chat framing.
- 8470f00 (#180): persist/restore unfinished chat-view batch state, retaining legacy-array compatibility; includes killed-process regression.
- 924e61f (#182): live child zoom reads retained session entries plus the unsaved tail, preserving earlier evidence across SDK compaction.
Skipped release-only d53e46b and README restructure 2c86c80; local version remains 0.8.4.
Adaptations: kept local search-summary labeling with upstream's 1560-byte fixture budget; damaged-tree fixture uses 100 bytes because its irreducible root renders as 86 bytes including framing; summary loading uses Map.has for existence-only schema/tree checks rather than fetching unused values.
Fresh evidence: typecheck passed; full suite 386 passed, 1 skipped (387 total); Pi 1.2 compatibility 2/2. Includes live zoom/compaction/reopen and interrupted-batch tests with synthetic providers only. git diff --check passed with existing line-ending warning. Ripwire quality-delta exit 2 (17 shared-worktree findings); test-gate exit 4 remains unresolved. No commit/push, paid calls, or runtime reload. Existing recovery work preserved. These updates supersede the earlier OptChat test counts above; PMA remains a separate ongoing lane.
