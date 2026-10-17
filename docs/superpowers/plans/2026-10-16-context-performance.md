# Context performance implementation plan

**Goal:** Recoverable build/test output, bounded retrieval/search, measured prompt overhead, stage timings, performance gates, focused child context, and actual agent model/thinking columns.

**Architecture:** Original tool results stay in Pi/session/memory and the operation journal. Only provider-context projections may replace large shell text with deterministic previews, after durable profile/session-scoped storage. No external code/dependencies/model calls. Fail open to original output. Preserve pre-existing diagnostic-journal edits. No commit, push or reload requested.

**Tech stack:** TypeScript, Node fs/crypto/performance, Pi 1.2 extension hooks, node:test.

## Tasks and acceptance
- [x] `src/agent-model.ts`, `src/inspector.ts`, `src/agent-view.ts`: separate model(thinking) column from persisted actual run data; update active records on model/thinking events. Test official SDK levels, historical unknowns, terminal sanitization, narrow widths.
- [x] `src/output-store.ts`, `src/output-context.ts`: atomic originals in scoped directories, SHA-256 integrity, TTL 7 days, bounded 64 MiB storage and 8 MiB/result; no eviction of live references to admit new ones. Text-only shell results above 8 KiB; preserve error metadata, original transcript, first/last/diagnostic lines, explicit omissions. Fall back on any storage failure. Tests for restart, corruption, isolation, quotas, unicode, errors, mixed image output and original immutability.
- [x] Retrieval tool with bounded character paging and literal search, untrusted-data label, missing/expired explicit errors, no arbitrary file paths. Register main and child tools as read-only.
- [x] `src/performance.ts`: bounded numeric-only aggregate stage metrics for context, tool, provider response/first content, settlement/persistence, compactor and child opening. Measure system/tool schemas separately; no raw user data. Use existing cache splitting; do not rewrite mandatory prompt/skills.
- [x] Focused child context: opt-in setting, compact newest history with explicit older-history retrieval, task/instructions/operational state exact; connected conversations retain normal history. Verify bounded input and defaults, no fabricated relevance inference.
- [x] `test/context-performance.test.ts`, benchmark script: sanitized build/test fixtures, preserve all error diagnostics in corpus or retrieve when omitted, compare estimates/latency/extra reads; generous local CPU guard, no provider performance claims. Existing RTK output below threshold is unchanged.
- [x] Integrate, run focused tests, typecheck, full suite, Pi compatibility, ripwire edit-check/quality-delta/test-gate; inspect diff; document results and limitations. No paid calls or auto-reload.

## Progress
Initial state: main except previously validated uncommitted diagnostic-journal improvement. User approved six proposed performance improvements and an agent model/thinking column. Earlier edits preserved.

Implemented and offline verified: output projection/search/integrity/quota/retention; actual SDK main+child full flow and canonical-original preservation; numeric aggregate timings and prompt/schema budget reporting; shorter zoom description (719 bytes to 536); opt-in focused history; actual persisted model/thinking column, narrow rendering and metadata updates. No vendor code copied.

Validation: TypeScript passed; full suite 415 passed/1 skipped. Focused 22/22 and Pi 1.2 compatibility 2/2 passed after removing an unnecessary second shutdown handler (the compat fixture counts registered handlers). Offline three-fixture benchmark: prior capped context 7,500 estimated tokens each versus 302–328; 96% reduction, 0 required diagnostic reads. Not provider-token, billing or real-world latency measurements.

Static checks: edit-check passed; quality-delta exit 2 (10 major findings: duplicate generic helpers/test fixtures and short-horizon churn; no pinned baseline). Test-gate exit 4 includes graph coverage gaps, not a green gate. Do not create a baseline or weaken tests to hide these. `git diff --check` passed with existing README/doc LF→CRLF warnings.

Final validation after output-size/cache-retention boundary changes: TypeScript and full suite passed again (415 passed, 1 skipped); benchmark and edit-check passed. Final benchmark cold projection 3.47–5.77 ms; warm 0.0001–0.0003 ms, with the same 96% token-estimate savings and no additional fixture-evidence reads. Final diff reviewed; whitespace check passed. Quality-delta still exits 2; test-gate still exits 4. No hidden baseline/reset/ignore changes. Live provider and active TUI after reload remain not verified; no paid inference, commit, push or reload performed. Focused history stays OFF by default to avoid concealing older chat-only constraints.
