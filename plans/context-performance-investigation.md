# OptChat: context, performance, and LLM utility

Read-only investigation of source at `90d6ab7fb` plus the existing Shells changes and concurrent fixes to the three previously approved findings. No provider inference, user history, credentials, or production profile was used. This is an evidence-backed recommendation, not an implementation claim.

## Reproduce

From this worktree, with Node 24:

```sh
node --experimental-transform-types plans/context-probe.mjs
```

The probe uses synthetic messages and an in-memory no-op Store. It creates no profile/files, makes no network requests, and never invokes a provider. Its scale fixture has prebuilt summary nodes and a highly folded saved view. It does NOT measure JSONL disk parsing, fsync, realistic provider latency, tokenization, actual cache hits, or semantic quality of generated summaries. Runtime: Node 24.15.0 on Windows. Times are illustrative local samples, not statistically established latency guarantees. Approximate token counts use characters/4, not a tokenizer.

## Vetted findings, ordered by value

| Priority | Evidence | Consequence | Effort / fix risk / confidence |
| --- | --- | --- | --- |
| P1 | `src/transcript.ts:235–239` retains the first user message and final step, but not intermediate user steering. The active path is `src/index.ts:478–487`; the more conservative `retainedRun` in `src/run-context.ts` is not used there. | Synthetic refresh removes the literal instruction `NEW CONSTRAINT: never publish` from the native run. It may survive in the memory summary, but safety constraints now depend on a lossy model instead of exact text. This does NOT establish that an actual model violated the instruction. | S–M / medium / high |
| P1 | `src/index.ts:417–420` bounds a tool result before logging it; `src/transcript.ts:74–82` caps it again. | A 42,021-character result becomes 29,997 stored characters; a unique fact in its middle is absent from `zoom`. Paging cannot recover content never stored. The omission notice is honest, but the persisted memory is not an exact original. Pi's own session may retain a copy; the probe only establishes failure through OptChat memory. | M / medium: persistence + tool/result pairing / high |
| P2 | `src/index.ts:478–487` refreshes based on native run characters; `VIEW=128,000` in `src/memory.ts:5` is independent of model window. `needsRunRefresh`/`assertContextFits` in `src/run-context.ts` have test consumers, not this main path. | A synthetic 128,015-byte view with a 32,768-token model and a tiny run does not trigger this refresh. The assembled request is approximately 32,162 tokens BEFORE real tool schemas/system prompt/output reserve. This establishes a budgeting gap, not an observed provider overflow; Pi may apply its own guard later. | M / medium / high for gap, medium for real impact |
| P3 | `src/memory.ts:148–166` loads all entries/nodes into RAM; `search` at 422–436 scans originals for cold queries; every append clears its cache at 407. | At 100k synthetic messages (about 200k nodes), startup is ~165–169 ms; first search ~64–69 ms, warm query ~0.023 ms, query after append ~10.4 ms. Full-history RAM grows with the archive. No demonstrated interactive bottleneck at smaller sizes. | M–L / medium–high / high for measured scaling, low for need to redesign now |

## What to implement next (recommendation, not yet authorized)

1. **Keep live instructions exact.** Preserve all live user steering and non-displayed custom context when refreshing, while retaining only the last complete tool exchange. Recompute the retained-context budget with those instructions included. Never truncate instructions to meet the budget: refuse with an actionable message if they alone do not fit. Regression: multi-steer run, newest correction supersedes older one, images/custom messages preserved, no orphan results, repeated refresh, and failure retains the originals. Verify `test/mid-turn-refresh.test.ts`, `test/active-run.test.ts`, full check/tests and Pi1.2 compatibility gate.
2. **Separate durable originals from bounded LLM previews.** Store full tool text (paged or an explicitly retrievable spill artifact) before creating a bounded native message. Avoid independently splitting tool calls/results in ways that break `resultOf`/`callOf` adjacency; preserve provenance and IDs. Regression: unique fact at the head/middle/tail of a >CAP tool result is recoverable after refresh AND restart, paging covers it with no loss; huge output remains bounded in the request. Read `src/memory.ts` pairing logic and existing store contracts first. A larger preview cap alone is not a fix.
3. **Budget the actual assembled request.** Include view, system instructions, tool schemas, previous exchange, current run and output reserve. Adapt the view to the remaining budget through existing built nodes, retaining a stable cache prefix where feasible. Do not silently drop user text or admit missing-summary placeholders as equivalent data. Regression: 32k/128k/272k windows, many tool schemas, Unicode-heavy content, large image/parallel outputs, model switching, oversized user-only input, and no second pointless compaction after refresh. Provider-token usage is preferable to raw bytes where valid; estimates need an explicit margin.

These should precede a disk/search architecture rewrite: correctness and retrieval quality dominate the measured microsecond rendering cost.

## Performance observations

Second local run:

| Messages | Nodes | Load ms | Cold search ms | Warm search ms | Search after append ms |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1,994 | 2.29 | 0.675 | 0.001 | 0.153 |
| 10,000 | 19,995 | 12.93 | 4.662 | 0.003 | 1.188 |
| 100,000 | 199,994 | 164.78 | 69.397 | 0.023 | 10.393 |

The fixture's 5–6-line rendered view took ~0.001–0.003 ms. A separate 256-line, 128,050-byte synthetic view rendered in a 0.050 ms median over 21 runs. These warm in-memory timings exclude provider payload conversion and tokenization; neither establishes an end-to-end latency improvement. Heap deltas varied markedly with GC (~113–165MB at 100k across two runs), so they are not an allocation budget. Cold search and post-append search differ because JIT/strings are warm, even though the result cache was invalidated. Do not extrapolate these results to real disk startup or provider inference.

## LLM usefulness: how to evaluate before tuning

**First build an offline oracle suite**, not a new vector store. Synthetic conversations should contain exact decisions, changed requirements, revoked authorization, branch selection, identifiers, error evidence, unresolved blockers, and quoted malicious instructions. Expected outcomes are exact fact retrieval through supported memory tools, correct latest-decision precedence, source IDs, and recognition of unknowns. Exercise long tool output, restart, repeated refresh, Unicode and many tree merge levels. This detects mechanical data loss without paid calls.

**Then an explicitly opt-in provider evaluation** can compare factual recall after real multi-level compression. Measure answer correctness, false certainty, source-grounded retrieval, zoom depth/calls, extra input tokens, compaction attempt amplification, time waiting for summaries, and provider cacheRead/cacheWrite. Fixed fixtures, pinned models/settings, alternating order, repeated runs, privacy-safe metadata only. No paid evaluation was run or authorized in this investigation.

**Do not equate compression ratio with quality.** Preserve decisions/constraints/provenance before optimizing bytes. Shorter summaries can hide the very clue needed to discover an older fact; perfect `zoom` recovery is useless if the summary no longer signals that it exists. Tune 512-byte summaries, concurrency, previous exchange and search availability only against the oracle and provider-quality metrics.

**Useful diagnostic surface:** show actual accepted/rejected summaries, retry amplification, backlog age, time blocked waiting for settle, view/native/system/tools budget shares, and retrieval calls. Existing `compactor-diagnostics.ts`/usage ledger can be extended with bounded metadata, without transcript text or credentials. Do not claim a cache improvement solely from identical prompt prefixes: validate provider cache usage.

## Not recommended without new evidence

- Vector database/embeddings or automatic semantic retrieval: new cost, privacy and relevance risks, while exact retrieval first has a concrete data-loss problem.
- General `index.ts` rewrite: churn alone does not prove a latency problem.
- Raising compactor concurrency above eight or switching to a cheaper/faster model without quality/rate-limit measurements.
- Lazy disk storage as the immediate next task: benchmark representative real archives and peak RAM first.

## Status

Three earlier approved fixes are being implemented separately: reject oversized compactor fallbacks, correct browser leaf representation, and add a Pi1.2 runtime gate. This document does not change their source files. The additional recommendations above remain investigated, not implemented. Interactive Shells UI and real-provider quality are not validated by these tests.
