# Resolution-on-demand implementation and evidence ledger

## Objective and authority
Evolve Victor Taelin's append-only chat + binary summary tree: bounded reference-based working focus, precise/easy zoom, retrieval-oriented summaries, and refresh continuity. Preserve chronological tree/cache prefix, permanent originals, user instructions, and complete tool exchanges. No parallel authored memory, embeddings, extra summarizer, or model-facing token micromanagement. User authorized implementation, agents and benchmarks; no commit/push/release or live-profile edits. Synthetic/offline checks first; provider quality/cache gains require actual separate evidence.

## Architecture and ownership (multi-seam)
Baseline: 62bb6c02e. One writer per cwd, workers return uncommitted durable diffs; parent integrates only after handoffs. Worktrees are inside ignored scratchpad/worktrees; dependencies use local junctions, no installs.

| Lane | cwd suffix | Exclusive seam | Gate / handoff | Independence |
|---|---|---|---|---|
| focus | scratchpad/worktrees/resolution-focus | new src/focus.ts + test/focus.test.ts | bounded, recency-based reference store; no source ownership overlap | pure policy module |
| zoom | scratchpad/worktrees/resolution-zoom | src/tools.ts, new src/zoom-navigation.ts + test/zoom-navigation.test.ts | backward-compatible literal find within selected node, scoped navigation receipts, boundary/image tests | tool contract |
| summary | scratchpad/worktrees/resolution-summary | src/prompts.ts + test/summary-navigation.test.ts | retrieval landmarks, source attribution/revocation/uncertainty, no invented authority | summarization contract |
| integration | main checkout | index.ts/transcript.ts, integration tests, benchmark harness/docs | request budget, refresh, isolation and stable-prefix integration | follows component handoffs |

## Planned contracts
- Focus is expendable, session-local metadata of successfully opened original/tree references (id,n,offset,limit), not stored copies or authority. Bounded references and rendered bytes, deterministic most-recent-used eviction; render from originals/current nodes. Refresh and next turn retain relevant focus; profile switch clears it. Automatic cool-down and explicit release prevent sticky obsolete facts. No automatic full-message expansion.
- Zoom remains compatible with id+n, original/images, agent transcript and pagination. Add optional literal findText within explicitly selected range, return bounded source-located passages with exact follow-up calls, no whole-history scan or fuzzy guessing. Invalid/conflicting parameters fail clearly. Existing image and surrogate boundaries preserved. Successful read callback lets parent add focus; failed calls never add references.
- Compaction remains one tree operation. Preserve retrieval landmarks by value: subject + exact decision/reason/revocation, authority scope, attempted vs verified, uncertainty, original identifiers. No invented causal certainty or second task ledger. Agent instructions distinguish historic focus excerpts from current user authority.
- Parent integration appends bounded focus AFTER chronological view, before dynamic state/current task, and includes it in request budgeting. Drop focus before coarsening more tree or refusing oversized requests. Do not change original tree scheduling or refresh threshold without measurements.

## Acceptance / evidence
- [ ] Reference focus restores old-topic detail across turn/refresh without changing tree bytes; recency, expiry, release, profile isolation tested.
- [ ] Zoom precise literal lookup avoids full-read paging, respects selected source range, handles absent/Unicode/huge/conflicting inputs; existing callers/images unchanged.
- [ ] Summary/AX instructions preserve retrieval cues, correction ordering and historical provenance; fixtures measure navigability, not unproven model fidelity.
- [ ] Whole-request budget includes focus; fallback evicts expendable focus rather than live user messages/tool exchanges; stable prefix unchanged on focus updates.
- [ ] Paired deterministic synthetic replay: old topic, repeated refresh, superseded decision; report retrieval calls/bytes, constraint visibility, latency distribution and stable-prefix bytes. No timing-threshold games or claims of provider cache hits from prefix estimates.
- [ ] Focused regressions, typecheck, full suite, Pi compatibility, scoped diff review, ripwire edit-check/quality/test-gate. Gate failures classified, not hidden.
- [ ] Independent fresh review; all in-scope defects fixed, integration revalidated.
- [ ] Discoverable README/skill in established dotfiles source, preservation of other pending goal-x edits; fresh discovery/loading offline. No silent live activation.

## AXI follow-up (now active)
The user authorized the deferred fork adaptation after this integration. Reference: `kunchenguid/axi` at `0374ba4118d45b08b90bf8c9b1df4a774b2d72f4`, linked from axi.md. Native Pi tools keep their JSON/details/error/permission contracts instead of adopting CLI stdout conventions. Scope, tests and remaining limits live in the dotfiles plan `plans/pi-axi.md`; the shared `axi-interfaces` skill provides the reusable checklist.

## Async completion interruption (2026-10-22)
User reported `OptChat has no current user message; refusing to send historical context.` followed by abort while waiting for the workers. Reconciled workflow cc403063-0ecd-498a-a749-c19e6747ee03: all three children completed; no reruns. Root cause: pi-subagents background completion notifications can use `display: false`; asUser intentionally preserves their custom role, while buildContext incorrectly required a current user role. Regression reproduced that exact error in two tests. Fix permits current custom input without fabricating user authority, injects the tree into the custom message when necessary, and still rejects historical-only replay. Eight initial unit/context tests passed. Follow-up found and fixed custom-only mid-run refresh admission; first-user-or-custom task selection now retains the starting event and latest whole tool exchange. Real fixture flow verified on pinned Pi 1.2 and installed Pi 1.3, both before any typed user turn and after one: hidden notice -> provider request -> large old tool pair -> small current pair -> actual index refresh -> response. Custom metadata/provenance and profile instructions retained. No live reload or publishing.

## Integrated validation (2026-10-22)
- Typecheck passed; full suite 589 passed, 1 platform skip, 0 failed; Pi 1.2 compatibility 2/2. Installed Pi 1.3 async-wake/actual-refresh fixtures 2/2. All fixture providers synthetic, no external inference.
- Review 34111b0c-b7c9-47cc-aa0c-ecedf913d2bd: OK with notes, no remaining blockers. Accepted findings fixed with red-to-green tests: reserved focus framing (quoted source lines; not an immunity guarantee), original-vs-summary attribution, summary zoom ignored-limit callback, custom-only refresh, newest-hit retention, bounded scanning including copied logs, canonical prompt order. Empty-first-prompt and duplicate-call findings disproven/withdrawn from concrete source/tests; live compaction guidance is not duplicated through legacy COMPACT.
- Seven qualified edit-checks passed. Ripwire quality-delta remains exit 2: 13 gating findings, consisting of new test-fixture clone pairs (9) and touched-symbol short-horizon churn (4), no complexity-budget bypass. Test-gate remains exit 4: 15 statically untested impacted symbols, 1 module scope; full runtime suite passing does not change that static result. No baseline resets or gate weakening.
- Final deterministic retrieval benchmark: selected branch 7 calls/21,921 returned bytes -> 2 calls/1,177 bytes; four scripted focus boundaries 4 rereads/81,892 bytes -> no extra tool reads/6,892 injected bytes. Focus-render median ~0.0058 ms, p95 ~0.0080 ms (100 local samples). Chronological view unchanged. Synthetic/scripted policy results only: model summary fidelity, reasoning, provider cache hits, cost and whole-agent gains NOT VERIFIED.
- Live activation pending `/reload`; no live goal, compactor-model setting change, commit, push or release. AXI follow-up is now tracked separately above.

## Historical implementation state
2026-10-22: baseline checkout clean; topology and ownership recorded. Workflow cc403063-0ecd-498a-a749-c19e6747ee03 / mission 0a96a8cd-aed4-4c3b-bdd6-fa11693d1c27 runs three Sonnet 5.5 high workers in isolated worktrees. Parent added optional focus budgeting/context integration, turn/refresh snapshot lifecycle in index.ts (awaiting component modules), runtime integration fixture, deterministic replay harness, package skill/docs/discovery and benchmark command. No push/reload/provider benchmark calls. Focus assembly tests passed 4/4 (resolution-context.log). budgetContext edit-check passed. Runtime/full gates and replay not yet run: required component files are still owned by active workers. Summary worker found COMPACT/MASTER legacy text is not the active main/compactor path; approved exports NAVIGATION_DOC/SUMMARY_SIGNPOSTS, parent must wire index.ts and compactor.task while preserving shared recipe system prompt. Next trigger: component handoffs automatically wake parent for diff integration, runtime tests, benchmark, independent review, full gates and dotfiles source-only capture. No polling.


## AXI full-gap follow-up — native input boundary

- Retrieval admission now rejects unknown `date` fields; missing dates and JSON array indexes name their valid range. Installed native Code Mode validation is exercised by the retrieval tests.
- Parent audit reproduced extra-key admission in the remaining registered tool schemas: misspelled shell timeout/options and per-task cwd could be silently ignored before execution. All twelve native tool registrations now reject unknown top-level keys; `spawn.tasks[]` is strict as well. Existing documented arguments are unchanged.
- Regression `test/tool-inputs.test.ts` registers the actual extension without opening a profile. A real native dispatch with an in-memory shell-body stub proves invalid arguments yield `isError` before execution, and valid inputs still reach the stub. No actual shell or agent starts in these tests. Focused input/operation/metrics tests: 35 passed; TypeScript check passed.
- Quality/coverage findings must be dispositioned, not suppressed: test-fixture duplication, short-horizon churn, and unresolved callback edges are not automatically defects. Full-suite, live TUI reload, semantic compactor fidelity, provider cache/billing and native macOS/ACP are separate acceptance criteria.
