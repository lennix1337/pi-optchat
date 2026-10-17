# Offline performance budgets

`test/performance-budget.test.ts` protects deterministic byte/token ceilings. `test/performance-benchmark.ts` measures local CPU work on synthetic in-memory data; it makes no provider calls and never opens a user profile. The coordinator can wire the benchmark into a package script without changing its workload.

## What is measured

The harness assembles a Pi-shaped request through OptChat's real prompt constants, `Memory.render()`, `buildContext()`, real memory/retrieval tool schemas, and `PerformanceMetrics.context()`. The fixture has 256 synthetic entries and a 129-line memory view (one older summary plus 128 recent entries), a prior exchange, and a current user request. Base tools are `zoom`, `date`, `search`, and `output_read`; an optional variant adds `context_metrics`, which is not a default main-session tool.

The cold `memoryConstruction` timer includes generating the synthetic entries/tree and constructing `Memory` from them with a no-op in-memory `Store`; its compressor throws if called. It is a fixture-setup proxy, not full process, Pi, extension, disk, or provider/model startup. The benchmark also reports before/after whole-process RSS/heap/external-memory snapshots; these include loaded modules and allocator/GC effects, are not isolated fixture deltas, and do not gate tests. The prompt includes OptChat's stable core prompts and a small synthetic project-context section; it deliberately has no user AGENTS/skills catalogue. The reported `estimatedContextTokens` is Pi's estimator, not provider billing.

## Gating budgets

| Measure | Base request | With optional diagnostics | Rationale |
| --- | ---: | ---: | --- |
| Serialized active tool schemas | 8,192 B | 10,240 B | Explicit caps on schema overhead; diagnostics has a separate, opt-in allowance. |
| Serialized assembled request | 32,768 B | 32,768 B | Holds the synthetic core prompt, memory view, current/prior messages, and active schemas. |
| Pi estimated context | 10,000 tokens | 10,000 tokens | A second ceiling uses the application's own context estimator. |

Tests compare repeated assemblies byte-for-byte and gate only these deterministic sizes and evidence-preservation checks. Hardware timings are **not** assertions. If intentional prompt/tool growth exceeds a budget, update the limit with a measured explanation rather than silently raising it.

## Reproduction and sample measurement

Run the focused test:

```sh
npx tsx --import ./test/support.ts --test test/performance-budget.test.ts
```

Run the offline benchmark (default: 2 warm-ups, 9 measured repetitions):

```sh
npx tsx --import ./test/support.ts test/performance-benchmark.ts
```

Set `PERF_REPEATS` to an integer from 3–50 to change repetitions. The JSON includes Node/OS/CPU, workload, budgets, sizes, and min/median/p95/max times. At nine samples, nearest-rank p95 is the maximum; treat it as a small-sample range, not a stable tail-latency estimate.

Observed on Windows x64, Node v24.15.0, AMD Ryzen 7 9800X3D, 16 logical cores; 2 warm-ups and 9 measured repetitions:

| Measure | Base | With `context_metrics` |
| --- | ---: | ---: |
| Active tool schema bytes | 2,428 B | 2,668 B |
| Serialized request bytes | 18,018 B | 18,258 B |
| Pi estimated context tokens | 4,305 | 4,365 |

| Local operation (includes only named work) | Min | Median | p95/max |
| --- | ---: | ---: | ---: |
| Generate synthetic fixture + construct in-memory `Memory` index | 0.305 ms | 0.553 ms | 3.563 ms |
| Render memory view | 0.012 ms | 0.016 ms | 0.036 ms |
| Assemble base request + telemetry | 0.140 ms | 0.227 ms | 0.348 ms |
| Assemble request + telemetry with optional diagnostics schema | 0.129 ms | 0.187 ms | 0.415 ms |

The benchmark process-memory snapshots were RSS 194,281,472 B / heap 75,878,352 B / external 8,358,697 B before the workload and RSS 204,509,184 B / heap 68,262,632 B / external 8,389,336 B after measurement. They include runtime/module overhead and garbage-collector effects. These are one local run, not a before/after comparison or a claim of performance gain. The optional-schema timing is not expected to be slower in such a tiny sample. Different hardware, Node/Pi versions, caches, profiles, skills, provider framing, and model tokenizers change results. In particular, these synthetic figures are not comparable to OpenHuman's mock-inference task/fleet benchmarks, and they say nothing about provider latency, billing, or task success.
