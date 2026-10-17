# OptChat optimization: real-harness results and remaining blockers

## Bottom line

The comparison now runs **the real OptChat**, with its memory, context projection, compactor, tools and operation-recovery safeguards inside each isolated task container. It no longer substitutes bare Pi plus a custom container tool.

Two product changes are implemented:

1. **Less preview work:** compute selected output lines once instead of twice. Identical output/metadata; measured component median reductions of **13.45% / 41.67% / 29.01%** on log/diff/search fixtures. This is milliseconds of local CPU time, not overall model speed.
2. **Fix a real task-blocking recovery bug:** ordinary `rg` failures and quoted regex alternation were incorrectly classified as potentially mutating shell commands. A missing `rg` binary then blocked subsequent edits. The new conservative, quote-aware recognizer permits simple searches while rejecting executable `rg` helpers, configuration-based execution, expansions and mixed mutations. Unit, real-extension process and official-image Docker regressions verify failed searches followed by a successful real edit/readback. It does not clear or bypass genuine uncertain mutations.

**The broader goal is not complete:** the second change's real-model task outcome is blocked by the explicitly selected account-2 quota, and the baseline official grade is blocked by its 12-GiB free-memory prerequisite. No account switching, quota retry, or safety-gate waiver was performed for those blockers.

## Real-model campaign

The ten fixed tasks were attempted once per frozen baseline/candidate runtime: **20 distinct task/variant attempts**, not retries. Both use account 2, `gpt-6-luna`, high thinking, 4 CPUs / 4 GiB, network disabled, no host mounts. An explicitly recorded shared-host protocol permits only the idle GitHub MCP service; unknown/busy workloads block. This is not equivalent to the earlier OpenHuman/bare-Pi/exclusive-slot experiment.

| Metric | OptChat baseline | Preview candidate |
|---|---:|---:|
| Task generation runs with complete successful transport | 8/10 | 10/10 |
| Main results captured | 9/10 | 10/10 |
| Actual model requests, including compactor | 380 | 324 |
| Responses with recorded usage | 359 | 305 |
| SDK tokens including cache + compactor | 2,027,862 | 1,626,096 |
| All-call cache-read / input+cache | 70.57% | 64.65% |
| Main-call cache, eight paired successful runs only | 79.15% | 69.95% |
| Aggregate recorded duration incl. setup | 885.36 s | 744.94 s |
| Official grading | Blocked before launch | Executed; result details below |

These totals do **not** establish a causal speed/token improvement. Baseline contains a response-budget failure and a shutdown transport defect, tool trajectories differ, candidate ran second, and empty patches can reduce work. The preview change preserves provider-facing content and is not expected to increase provider cache hits. **Cache did not improve.** Compactor calls are included, unlike the old bare-Pi experiment. Original concurrent trace attribution was corrected later; aggregate usage above comes from keyed provider-response records, not those affected trace rows.

Four task patches were byte-identical between variants. Predictions, individual receipts, hashes and aggregate evidence are preserved in `scratchpad/real-optchat-results-20261016/` and `optchat-real-comparison.json`. Frozen runtime hashes differ only in `src/output-preview.ts`.

### Failures preserved, not replayed

- Baseline Django13569: response watchdog reached 60 seconds; task stopped, no captured final patch.
- Baseline Requests: final successful main response and 588-byte patch captured, container exited 0; background compactor cancellation on shutdown incorrectly failed the host transport. The original failed receipt is unchanged. Offline cancellation regression now passes. Candidate's Requests patch was byte-identical.
- No failed task/variant was re-generated under the same snapshot. Preflight-only image-name rejection for hyphenated official repositories was repaired before any inference for those tasks.
- Shell timeout during one campaign slice was reconciled against the completed durable Django15572 candidate receipt and observed absence of task containers; it was not replayed.

## Correctness evaluation

The preview candidate was graded once using SWE-bench 5.0.2, fixed dataset revision `78f471bf655a3137b2e8a75af1501690ec009ec3`, one worker and 1,800-second task timeout. Launch had **13,284,667,392 free bytes (12.37 GiB)**, satisfying the 12-GiB gate. No old predictions or old grade were overwritten.

The untouched official aggregate reports:

- **5 resolved**: Django13569, Django14672, Matplotlib24570, scikit-learn14141, SymPy16766.
- **1 failed**: Pylint4970.
- **3 empty patches**: Django15277, Django15572, SymPy13031. Generation completion is not correctness.
- **1 evaluator error**: Requests5414. The model patch applied and tests ran, but the evaluator read its UTF-8 log using Windows cp1252. This is a new **decode** error, distinct from the older evaluator's output-write error.

The saved Requests output was subsequently parsed **offline** using the unchanged official parser under Python UTF-8 mode. It resolves the task; the original test-output SHA-256 stayed `6cdd7111239db9f6fbfd161954554323e858efd36e00a031047b9e1814de40fe`. **No tests, inference, or grader container were rerun.** Thus preserved evidence determines six resolved outcomes, one actual failure and three empty patches; it does not convert the raw aggregate into an error-free official 6/10 run. The raw report still says five resolved plus one error.

Baseline predictions are prepared and validated, but its grader was blocked **before launch**: 12,525,195,264 free bytes = 11.67 GiB, below 12 GiB. Safe Docker-cache reclamation did not provide the missing headroom; no unrelated application was stopped. Do not compare a graded candidate to an ungraded baseline as a score improvement.

## Grader-guided product repair

Without inspecting reference patches, generated tool transcripts showed the common failure:

```text
rg -n "class CharField|MaxLengthValidator" django/db/models/fields
/bin/bash: rg: command not found
# Prior classifier treated rg as mutating, and split the quoted | as a shell operator.
# Later ordinary edit calls were blocked by the uncertainty barrier.
```

The repair is in **production** `src/operation-diagnostics.ts`, not a runner-only prompt workaround. Failing regressions were observed before implementation; the fixed path executes real edit/readback after failed diagnostics. Dangerous `rg --pre`, decompression, configured helpers, glob-generated options, shell substitution and compound mutations remain protected. A non-allowlisted failed command still requires independent observation and reconciliation.

A separate `diagnostics-v2` runtime was frozen, differing from the preview candidate only in that production module. Its first guarded real-model probe reached the real OptChat/account-2 bridge but returned **quota errors with no successful response**. Receipt: `scratchpad/real-optchat-pilot-MnaLjW/receipt.json`; source SHA-256 `d83b01688c3aca6dd3bb24cfa880b196d498191825117c13028b8a5efd20c0a1`. It was not retried or silently switched to another account. That blocks a new quality claim for this repair.

## Acceptance status

| Requirement | Status | Evidence |
|---|---|---|
| Benchmark actual OptChat, not bare Pi | verified | Actual tools, memory/context, compactor and retrieval in official-image smoke and real receipts |
| Protect Windows, credentials and this conversation | verified for inspected containers/transport | No network, host mounts, credential forwarding or host tool dispatcher; disposable profiles |
| Preserve baseline/failures and prevent blind replay | verified | Frozen hashes, one actual attempt per original task/variant, preserved receipts, cancellation/recovery tests |
| Improve real product, not only infrastructure | verified locally | Preview CPU measurements; diagnostic-bug regression with actual tool execution |
| Improve cache or whole-agent latency | not verified | Measured cache ratios decreased; stochastic/confounded durations |
| Improve task-resolution score | blocked | Diagnostics-v2 quota; baseline grade RAM prerequisite; no new score claim |
| All repository static gates green | not verified | Dirty-repository quality-delta and test-gate remain non-green |

No commits, pushes, deployment, or reload were performed. The current installed conversation is not claimed to have reloaded these source changes.

## Final verification and resume boundary

- `npm run check`: passed.
- Full suite: **474 passed, 1 skipped**, zero failures (475 tests).
- Pi 1.2 compatibility: **2/2**; Docker staging/gate tests: **3/3**.
- Actual official-image regression: **11 main requests, 5 compactor requests, 10 tool round trips**; completed actual edit/readback after failed searches, preserved the genuine-mutation barrier, retrieved original output and cleaned up.
- Ripwire edit checks for `isReadOnlyDiagnostic` and `previewOutput`: passed. Quality-delta exited 2 (18 repository findings); test-gate exited 4. Diff check emitted only existing LF/CRLF warnings. Static gates are not claimed green.
- The grader wrapper now forces `PYTHONUTF8=1` in its isolated child environment. A regression failed before the fix; all **9 offline evaluator/fixture/LF/UTF-8 tests** now pass, including a real subprocess reading a Unicode log with default text decoding. This change was made after the preserved candidate grade and does not rewrite it or authorize a regrade. Old evaluator results and file hashes remain recorded; the new wrapper hash is in `scratchpad/real-optchat-results-20261016/grader-utf8-followup.json`.

No model/grade task is left running. Further model work must wait for the selected account-2 quota; do not switch the comparison to the main account simply because this conversation failed over. Further baseline grading requires a fresh >=12-GiB free-memory observation. Prepared predictions and frozen snapshots must be reused rather than regenerating successful tasks or replaying failures. The next live experiment is the diagnostic-code candidate, not another runner-only change.
