# Output-store retention performance

## Conclusion

A small quota-scan candidate did not produce a consistent, repeatable improvement, so it was reverted. The production `src/output-store.ts` behavior is unchanged. At 16 MiB the candidate was slower; at 40 MiB its median was effectively flat; at 60 MiB its median improved by only 1.8% while p90 regressed at every occupancy. With the observed outliers and changed host free memory, the measurements do not justify retaining the optimization.

## Method

The benchmark (`test/output-store-benchmark.ts`) ran serially in a dedicated window after the SWE tasks completed and before the grading worker resumed Docker work. The coordinator confirmed worker 64a775d8 deferred Docker grading for this measurement window. No model calls, credentials, billing, or external actions were used.

Each point is 25 successful `OutputStore.put()` samples: five writes in each of five fresh temporary profiles. Profiles used a 64 MiB shared quota, eight hashed session directories, 512 KiB valid retained records, and 256 KiB measured writes. Initial occupancies were 16, 40, and 60 MiB (actual: 16.001, 40.003, and 60.004 MiB). Seed records were kept live with a fixed test clock. The timer includes the quota scan, durable write, and built-in integrity verification; the follow-up read check is outside the timer. p90 uses nearest-rank over the 25 samples.

The candidate changed `record()` to reuse `lstatSync()` metadata instead of making a separate `statSync()` call. No other source changes were made between runs. The candidate was reverted after comparison.

## Results

Lower is better. Changes are candidate versus baseline.

| Initial occupancy | Baseline median / p90 | Candidate median / p90 | Median change | p90 change |
| --- | ---: | ---: | ---: | ---: |
| 16 MiB | 35.56 / 45.33 ms | 41.57 / 55.26 ms | +16.9% | +21.9% |
| 40 MiB | 96.76 / 103.93 ms | 97.36 / 118.30 ms | +0.6% | +13.8% |
| 60 MiB | 148.46 / 169.38 ms | 145.77 / 189.68 ms | -1.8% | +12.0% |

Raw per-write samples and per-repetition medians are retained in the ignored `scratchpad/output-store-performance/baseline.json` and `optimized.json` files.

## Environment and confidence

Both runs used Node v24.15.0 on Windows x64 (`10.0.26200`), AMD Ryzen 7 9800X3D (16 logical CPUs), with a 64 MiB quota. Reported free memory fell from 5,900 MiB before baseline to 5,223 MiB before the candidate. The isolated slot excluded the grading worker, but the host was not otherwise proven idle. Timing outliers occurred (including 275.6 ms at baseline 60 MiB and 472.9 ms at candidate 40 MiB); p90 worsened at all three occupancies. Treat the medians as one before/after trial, not a general production estimate. The evidence does not support a retained optimization.

## Validation

After reverting the candidate, `npm run check` passed and the focused output-context/query tests passed 15/15, including the invalid-record shared-quota regression. The benchmark harness is typechecked by the project check. The full repository test suite was not run.
