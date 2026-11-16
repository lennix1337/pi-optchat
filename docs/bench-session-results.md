# Copied-session benchmark results

One fresh process per measurement, 100 turns plus a bash turn, with 34 successful reads and one successful bash. Pi 1.5.2, Node v24.22.1, print mode, fixture model, compaction disabled; input fingerprint `aa7416f5ca5ce465356e6a17a139d41a815aae8ed84546f2fa7c3ddcb6a40f43`. Both runs used the same copied input; source baseline was commit `410f535`. Times are milliseconds; memory is MiB. Opening and per-turn loop measurements are intervals, not attributed CPU time. Each run's JSON also contains every individual turn's maximum and p99.

| Metric | Baseline | Attempt 1 | Stall diagnostic |
|---|---:|---:|---:|
| Opening wall time | 25,466.6 | 23,983.1 | 24,735.1 |
| Opening maximum loop interval | 251.3 | 220.1 | 253.8 |
| Opening p99 loop interval | 18.9 | 20.2 | 19.2 |
| Heap after GC before / after opening | 57.4 / 102.1 | 57.4 / 100.9 | 53.4 / 100.5 |
| RSS before / after opening | 224.9 / 219.0 | 226.4 / 220.1 | 207.7 / 208.1 |
| Final heap after GC / RSS | 108.3 / 361.7 | 107.0 / 360.6 | 108.0 / 362.9 |
| Maximum turn loop interval | 94.6 | 87.6 | 77.7 |
| Maximum of individual turn p99 intervals | 94.6 | 87.6 | 73.4 |
| Turn wall time p99 | 1,809.5 | 1,896.5 | 2,013.4 |
| Bash turn wall time | 465.0 | 454.8 | 404.4 |
| Bash maximum / p99 loop interval | 102.8 / 102.8 | 53.4 / 53.4 |

**Attempt 1 — discarded:** share a store reference per `Memory` instead of per `ColdEntry`. Final heap and several time measurements fell, but post-open RSS, opening p99 and turn wall p99 increased. A single run cannot distinguish noise from a regression; the strict no-regression rule therefore rejected the change. It was restored, and its prototype is not part of the product source.

**Stall diagnostic:** the third measurement adds lifecycle boundaries and retains active spans; it is diagnostic work, not an optimization. Its final RSS and turn wall p99 are higher than baseline, while other measurements are lower. One run per version cannot establish whether any difference is noise or a regression; no performance improvement or non-regression is claimed.

These measurements do not establish a live-memory improvement, identify the live bash stall, cover other extensions, or demonstrate the live RSS and stall targets. See [the benchmark instructions](bench-session.md) for isolation and limitations.
