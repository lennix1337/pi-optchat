# Harness benchmark: swe-x86-1 â€” with our Pi harness

Original columns reproduced from [OpenHuman summary](https://github.com/tinyhumansai/openhuman-benchmarks/blob/main/results/swe-x86-1/summary.md), retrieved 2026-10-16. Those published figures and ranking markers are not independently verified; their markers rank only the original columns.

**Not a controlled ranking:** original columns use `deepseek/deepseek-v4.1-flash`, high reasoning, 4 vCPU / 8 GiB per task. Our column uses **bare Pi SDK**, `openai-codex-account-2/gpt-6-luna`, high thinking, sequential **4 vCPU / 4 GiB**, OAuth subscription. **OptChat was not loaded.**

**â€  Incomplete, non-compliant evaluation:** 7 tasks resolved, 2 genuinely failed, 1 unknown due to evaluator output encoding. Grading started at **10.38 GiB free host RAM**, below its **12 GiB** gate. This is not a validated 70% score or evidence of a tie with OpenHuman.

| metric | openhuman | claude-code | codex | opencode | openclaw | hermes | deepseek-harness | **Pi SDK (ours)â€ ** |
|---|---|---|---|---|---|---|---| --- |
| resolved (SWE) / checks passed | **7/10 resolved** ðŸ”´ | **10/10 resolved** ðŸŸ¢ | **7/10 resolved** ðŸ”´ | **10/10 resolved** ðŸŸ¢ | **9/10 resolved** ðŸŸ¡ | **10/10 resolved** ðŸŸ¢ | **10/10 resolved** ðŸŸ¢ | **7 resolved / 2 failed / 1 unknownâ€ ** |
| patch produced | 7/10 | 10/10 | 7/10 | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |
| harness errors / timeouts (all tasks) | **0 / 0** ðŸŸ¢ | **0 / 0** ðŸŸ¢ | **3 / 0** ðŸ”´ | **0 / 0** ðŸŸ¢ | **0 / 0** ðŸŸ¢ | **0 / 0** ðŸŸ¢ | **0 / 0** ðŸŸ¢ | **0 / 0 generation failures**; separately 1 evaluator encoding error |
| system prompt tokens | **944** ðŸŸ¡ | 1,277 | 4,049 | 2,022 | **5,656** ðŸ”´ | 4,457 | **891** ðŸŸ¢ | N/M |
| tool schema tokens (count) | 3,647 (20) | **10.7k (20)** ðŸ”´ | **3,616 (9)** ðŸŸ¡ | 4,707 (10) | **1,990 (11)** ðŸŸ¢ | 8,789 (24) | 5,279 (25) | N/M |
| static prompt total (system + tools) | **4,591** ðŸŸ¢ | 12.0k | 7,665 | 6,729 | 7,646 | **13.2k** ðŸ”´ | **6,170** ðŸŸ¡ | N/M |
| cost / solved task | **$0.0077** ðŸŸ¡ | **$0.04** ðŸ”´ | $0.02 | **$0.0077** ðŸŸ¢ | $0.01 | $0.0082 | $0.01 | N/A â€” subscription, not comparable billing |
| tokens / solved task | **166.6k** ðŸŸ¢ | 427.5k | **369.7k** ðŸŸ¡ | 390.2k | 442.4k | 481.7k | **744.3k** ðŸ”´ | **26.97k** (7 resolved tasks; SDK tokens)† |
| total cost (all tasks) | **$0.05** ðŸŸ¢ | **$0.35** ðŸ”´ | $0.12 | **$0.08** ðŸŸ¡ | $0.10 | $0.08 | $0.13 | N/A â€” subscription; not $0 |
| cache hit % (solved tasks) | 90.6% | **56.1%** ðŸ”´ | 93.6% | 93.4% | **94.9%** ðŸŸ¡ | 94.5% | **96.2%** ðŸŸ¢ | **61.34%** (SDK cache-read / input+cache-read)† |
| TTFT p50 (solved tasks) | **1.18 s** ðŸŸ¢ | **1.38 s** ðŸ”´ | 1.36 s | **1.26 s** ðŸŸ¡ | 1.28 s | 1.34 s | 1.33 s | N/M |
| LLM call latency p50 (solved tasks) | **1.65 s** ðŸŸ¢ | 2.11 s | 2.01 s | **1.91 s** ðŸŸ¡ | 2.09 s | 1.99 s | **2.37 s** ðŸ”´ | N/M |
| task wall p50 (solved tasks) | **19.8 s** ðŸŸ¢ | 37.8 s | 36.1 s | **28.4 s** ðŸŸ¡ | **1m 02s** ðŸ”´ | 58.5 s | 55.2 s | **30.083 s** (runner elapsed, incl. setup/cleanup)† |
| cold start to first call p50 (solved tasks) | 814 ms | **269 ms** ðŸŸ¡ | **224 ms** ðŸŸ¢ | 1.19 s | 5.54 s | **10.0 s** ðŸ”´ | 855 ms | N/M |
| CPU time / solved task | **1.31 s** ðŸŸ¢ | 4.68 s | 3.28 s | 17.2 s | **26.7 s** ðŸ”´ | 16.1 s | **2.85 s** ðŸŸ¡ | N/M |
| peak RAM, process memory (solved tasks) | **68 MB** ðŸŸ¢ | 231 MB | **123 MB** ðŸŸ¡ | 1.06 GB | **1.57 GB** ðŸ”´ | 816 MB | 214 MB | N/M |
| peak RAM incl. page cache (all tasks) | **828 MB** ðŸŸ¡ | 1.08 GB | **503 MB** ðŸŸ¢ | 1.69 GB | 2.00 GB | **7.43 GB** ðŸ”´ | 1.02 GB | **396.60 MB** (task-container cgroup peak only; excludes host Pi)† |
| avg RAM (all tasks) | **296 MB** ðŸŸ¡ | 358 MB | **236 MB** ðŸŸ¢ | 756 MB | 1.11 GB | **4.14 GB** ðŸ”´ | 475 MB | N/M |
| side / sub-agent calls (failed) | 6 of 114 (0) | 7 of 175 (0) | 0 of 134 (0) | 10 of 177 (0) | 0 of 198 (0) | 10 of 195 (10) | 0 of 212 (0) | **0** — runner exposes only container_exec; no sub-agent tool |
| side / sub-agent share of tokens | 7.5% | 1.0% | 0.0% | 0.4% | 0.0% | 0.0% | 0.0% | **0.0%** — no sub-agent tool |
| LLM calls (errors) | 114 (0) | 175 (0) | 134 (3) | 177 (0) | 198 (0) | 195 (10) | 212 (0) | 82 successful assistant responses; not instrumented call count |
| prompt / completion tokens | 1.11M / 58.9k | 4.22M / 52.2k | 2.55M / 37.9k | 3.85M / 46.8k | 3.89M / 92.9k | 4.77M / 48.1k | 7.33M / 110.0k | 127,788 input + 162,176 cache-read / 8,001 output (SDK categories) |

## Metric definitions and limitations

- **N/M:** not measured with the source's definition/aggregation. Host Pi CPU/process RAM, TTFT, call latency and static prompt size were not captured. Solved-task token/cache/elapsed aggregates have now been recovered from receipts. Container memory was captured, but is not host harness memory. A 4-GiB memory cap is not measured RAM consumption.
- Source per-task KPIs use each harness's own solved tasks; cost per solved task includes all spend. Source cache hit rate uses cached/prompt tokens over solved-task calls. No all-task aggregate is substituted for those metrics in our column.
- Our receipts report **335.4 s summed task elapsed time** and **30.083 s solved-task p50**. The timer includes subscription preflight, container/session setup, generation, evidence collection and cleanup, so its boundaries may differ from the source. They record **82/82 successful assistant responses**, not independently instrumented provider call counts.
- SDK metadata reports **297,965 total tokens**: 127,788 input + 162,176 cache-read + 8,001 output. It separately reports 2,935 reasoning tokens; do not blindly add these again. SDK categories are not provider invoices or necessarily the original benchmark's prompt-token definition.
- Subscription billing is not allocated: monetary cost is **unknown, not zero**.
- The first grade's 0/10 was confounded by CRLF setup failures. The unchanged-prediction LF regrade produced the partial outcomes here. A later UTF-8 fix passed offline tests but was not used in grading. No new inference or patch tuning was performed.

## Our task outcomes

| Task | Result |
|---|---|
| django__django-13569 | Resolved |
| django__django-14672 | Resolved |
| django__django-15277 | Resolved |
| django__django-15572 | Failed: empty template path still returned `/testbed` |
| matplotlib__matplotlib-24570 | Resolved |
| psf__requests-5414 | Unknown: evaluator cp1252 output-encoding error |
| pylint-dev__pylint-4970 | Failed: `--duplicates=0` still printed a summary |
| scikit-learn__scikit-learn-14141 | Resolved |
| sympy__sympy-13031 | Resolved |
| sympy__sympy-16766 | Resolved |

## Evidence

- [Overall report](README.md) â€” OptChat performance experiments are separate from bare-Pi SWE-bench.
- [Inference receipts/report](../../scratchpad/openhuman-fixtures/results/account2-luna-high-sequential-4gib/benchmark-report.md) (local artifacts).
- [LF regrade report](../../scratchpad/openhuman-fixtures/results/account2-luna-high-sequential-4gib-lf-regrade-20261016/benchmark-report.md) (local artifacts).
- Predictions SHA-256: `6aaf283461e29143a7ad44134b8427f767be8ef46c688ea2c573d3cd79fbbff1`.
- Dataset revision: `78f471bf655a3137b2e8a75af1501690ec009ec3`; pinned evaluator `swebench==5.0.2` plus recorded LF correction.

This report adds a local comparison column only. No new inference, grading, commit, push, or upstream modification.

## Recovered receipt measurements

The original version unnecessarily left recoverable fields blank. The corrected column derives solved-task metrics from exactly the seven resolved IDs above, not all ten tasks.

- Solved-task SDK tokens: **188,757 / 7 = 26,965.29 per task**.
- Solved-task cache-read share: **61.34%**.
- Solved-task median runner elapsed: **30.083 s**.
- Maximum observed task-container `memory.peak`: **396,595,200 bytes (396.60 MB)**, including cgroup-charged page cache; **not** the memory of the host Pi process.
- Generation receipts: **10 completed, zero failure entries**, with **82 successful assistant responses**.
- Cost fields in SDK usage are pricing estimates, not subscription charges; they are not presented as paid cost.
- Missing TTFT, per-call timing, CPU time, host process memory and time-weighted RAM cannot be reconstructed from these receipts. Measuring them requires instrumenting a future run; this correction launches no inference.
