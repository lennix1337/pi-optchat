# Request budgeting and compactor telemetry

## Acceptance criteria

- Estimate the complete live provider request, not only transcript text: current system prompt, active tool schemas, memory/history, current input, state/status, and output reserve.
- Preserve content that has not already been summarized; refuse an over-budget request rather than silently truncating it.
- Attribute each compactor response to a per-invocation incident and attempt, with diagnostic-derived outcome/failure/category, while persisting metadata only.
- Treat provider policy refusals as terminal and expose a safe code for the memory scheduler; never infer refusal from ordinary summary text.
- Correlate a compaction with the recovery incident active when that compaction invocation starts.

## Implementation

- `run-context.ts` budgets the main assembled request with the live prompt/tools and reserved output; `index.ts` supplies that live context. A regression test checks prompt, active tool schemas, memory, prior history, current input, state, status, and output reserve, including an overflow that must refuse to fit. The compactor now calls `assertContextFits` on its complete system-message-plus-messages request before every provider attempt, reserving the selected model's full `maxTokens`; this covers both transport retries and correction prompts after an oversized summary. It never trims the source or view. Existing main/child request tests cover their actual assembled request paths; no transcript/cache/run-context changes were needed.
- Shared system/tool prefixes remain intact. Eight observed Haiku compaction requests each carried roughly 105–107 KB, including the full prompt and 17 tool schemas; observed totals were 233,332 cache-read and 85,254 cache-write tokens. There is no measured no-prefix comparison, so this evidence does not justify removing shared prefixes.
- `createCompressor` creates one UUID per invocation and uses it across provider attempts. Its final optional context factory snapshots `{ sessionId, recoveryIncidentId }` once at invocation; the snapshot is recorded in each trace and `recoveryIncidentId` is included in usage attribution. The parent integration supplies the current session/recovery IDs and forwards attribution to the usage ledger. The usage ledger keeps the compaction incident ID distinct from its recovery root ID.
- Policy refusal classification runs only on a provider error stop or thrown error. Compactor provider attempts stop and the error is replaced with a generic `Error` carrying `OPTCHAT_POLICY_REFUSAL`; provider text is not retained in the thrown error or diagnostic record. `Memory` treats that code as terminal, persists the block, and waits for an explicit retry. Successful summaries containing “policy” remain normal summaries. The diagnostic and usage attribution record `policy_refusal` from the bounded error evidence.

## Validation evidence

- Latest focused compactor, retry, diagnostics, request-budget/refresh, and usage run: 47 passed, 0 failed. This includes both compactor-fit regressions (oversized prompt/tools cause zero provider calls; a correction request fails after exactly one fitting call). Focused memory, summary-retry, and store validation: 58 passed, 0 failed, including terminal refusal persistence across appends/reopen and explicit retry.
- Latest `npm run check`: blocked only by a concurrent `test/recovery-runtime.test.ts:109` typing error (`content` may be a string before `.some`); no compactor or budget errors remain. An earlier check passed before that concurrent test edit.
- Last full `npm test` before the compactor-fit guard: 374 passed, 1 skipped, 1 failed. The failure was the unrelated `test/report-message.test.ts` queued-steer timeout in concurrent `src/agents.ts` work; a standalone rerun reproduced it. The parent identified the operation-identity cause and is fixing it in that lane. The full suite has not been rerun after the guard change, per coordination not to run that test concurrently.
- `git diff --check`: passed (Git emitted line-ending notices for concurrent diagnostics/usage edits).
- Ripwire `--edit-check=createCompressor` reports the intended 7-to-8 optional-argument contract change with zero incompatible callers. The full shared-tree quality delta/test gate are not clean because the same worktree contains concurrent changes: quality delta reports 13 gating findings; test gate identifies 48 test files and 19 untested impacted symbols. These broad results need integration-owner review, not attribution to this focused change alone.

## Pending integration check

- Re-run `npm run check` and the full suite after the concurrent recovery-runtime typing and report-message operation-identity fixes land; the report-message test is not being rerun concurrently with that fix. Reconcile the repository-wide Ripwire gates after concurrent edits. No commit or push was made.
