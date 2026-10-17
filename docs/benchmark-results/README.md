# Pi / OptChat optimization results

## Experiment boundaries

Two independent measurements are in progress. Their results must not be combined into a single speedup or score.

| Experiment | What it measures | Evidence / status |
| --- | --- | --- |
| Fixed 10-task SWE-bench baseline | Bare Pi SDK, Codex account 2, Luna/high, one isolated 4-CPU/4-GiB task at a time | All ten generation tasks completed across two preserved segments. LF regrade completed: 7 resolved, 2 genuine assertion failures, 1 evaluator encoding error. Incomplete and non-protocol-compliant (RAM gate missed); not an OpenHuman comparison |
| OptChat recoverable-output optimizations | Preview/context size, output recovery correctness, retention overhead | Earlier synthetic workload: estimated 7,500 → 308 tokens (96% fewer); not a provider latency measurement. Retention candidate measured and reverted: no reliable gain, worse p90 |

The SWE run is **not** equivalent to OpenHuman's published benchmark: model, authentication, harness, metering, and memory protocol differ. A completed model session is not a solved task. Only the pinned official grader can establish resolution.

## Baseline evidence

- Current run: `scratchpad/openhuman-fixtures/run-4gib-2026-10-16T03-36-29-628Z` (ignored local evidence).
- Actual selected provider: `openai-codex-account-2`; receipts are authoritative. The orchestration script's older display label names the base provider and must not be used as account evidence.
- Dataset revision: `78f471bf655a3137b2e8a75af1501690ec009ec3`.
- Previous attempts remain separate; they failed on the incorrectly selected base provider before useful inference and are not baseline task grades.
- The account-2 run stopped after six tasks because host free RAM fell below 5 GiB. Docker's guest had ~14 GiB filesystem cache; ephemeral cache reclamation recovered host headroom without persistent settings changes. A separate continuation completed only the four missing IDs in `run-4gib-2026-10-16T03-46-44-263Z`; completed tasks were not replayed.
- No automatic account switching, memory escalation, or quota retries. No reference/test patches are supplied to the coding agent.

## Optimization acceptance

Keep changes only with reproducible before/after evidence and preserved originals, diagnostic markers, session isolation, quota bounds, and recovery safeguards. Record failed experiments as well as successful ones. Never infer provider speed, cost, or cache savings from synthetic token estimates.

## Reports

- [Output-store performance experiment](output-store-performance.md): metadata-reuse candidate rejected and reverted; raw timing samples preserved. No measured speedup claimed.
- First official SWE grade: **0/10 reported**, but **model correctness not verified**: all ten evaluator logs contain CRLF shell/setup failures before test collection. Preserve this run rather than treating it as a valid quality baseline. Grader exited 0; that did not prove tests executed correctly.
- LF-write regression and Linux Docker execution smoke passed. The unchanged-prediction regrade (`pi-account2-luna-high-seq4gib-lf-65590e6b`) completed with **7 resolved, 2 assertion failures, and 1 evaluator encoding error**, but is **not protocol-compliant**: prelaunch host free RAM was 10,884,912 KiB (10.38 GiB), below the required 12 GiB. The worker mistakenly applied the generation protocol's 5-GiB threshold. Preserve this deviation alongside any result; do not claim protocol reproduction. No cancellation, relaunch, new inference, or model-patch changes are authorized by this observation. Prediction SHA-256 remains `6aaf283461e29143a7ad44134b8427f767be8ef46c688ea2c573d3cd79fbbff1`.
- Generation receipts: **82/82 successful assistant responses**, **297,965 SDK-reported tokens**, **0 OOMs**; these are not task-resolution or billing metrics. Initial grading took 186 seconds; evaluator containers were not capped to inference's 4-CPU/4-GiB limits.
- Post-experiment full suite: **451 passed, 1 skipped, 0 failed** (`npm test`; local evidence: `scratchpad/phase2-final-tests.txt`).

## Final grading findings

- Genuine failures: `django__django-15572` (empty template-path handling) and `pylint-dev__pylint-4970` (zero duplicate-line setting).
- Unknown outcome: `psf__requests-5414`. Windows cp1252 output writing failed after tests executed; report absent and output empty. Do not count this as a model failure or success.
- Post-run fix: explicit UTF-8 evaluator output, verified with LF/encoding regressions **4/4**. Not used in this regrade; no subsequent inference or grading performed.
- Evaluator OOM state was not captured per container; no daemon OOM evidence observed is not proof of no OOM.
- Detailed preserved report: `scratchpad/openhuman-fixtures/results/account2-luna-high-sequential-4gib-lf-regrade-20261016/benchmark-report.md`.

No end-to-end latency improvement or model-quality improvement has been established. The measured retention candidate was rejected rather than shipping a regression. Further model-quality experiments require a justified hypothesis and a fresh, clearly separated run; do not tune predictions to grader/reference patches.

Pending work is not a success claim.
