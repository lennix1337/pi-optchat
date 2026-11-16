# Offline session benchmark

This benchmark opens a **frozen copy** of an OptChat profile and Pi session in a disposable home, not the live profile. Use the same copies, Pi release, Node version, turn count and machine conditions when comparing changes. Run each comparison in a fresh process. The JSON includes a SHA-256 fingerprint of the allowlisted copied data and session; compare it before comparing measurements.

```powershell
$env:PI_BENCH_RELEASE = 'C:/Users/me/.pi/agent/install/releases/1.5.2'
node --expose-gc --experimental-transform-types scripts/bench-session.mjs `
  --source 'C:/path/to/copied/profile' --session 'C:/path/to/copied/session.jsonl' `
  --turns 100 --json "$env:TEMP/session-baseline.json"
```

The copied profile must contain `child-usage-counted.json`, its `runs` records and the copied child sessions they reference. The benchmark redirects those references to the copies and fails if one is missing. It copies only the data allowed by `bench-sandbox.ts`, creates a fresh configuration, refuses live OptChat and Pi homes and symbolic links in inputs, disables live-service integrations, and blocks `fetch`. Output files must not already exist. `--snapshots <new-directory>` optionally writes early and late V8 heap snapshots. Snapshots and copied inputs can contain private conversation data: keep them outside the repository and do not share them.

The fixture uses the specified installed Pi release and a local synthetic model, with Pi compaction disabled. It sends 100 turns by default, executing a real local `read` in one out of three, then a real `bash` running only `printf fixture`. It fails unless all fixture tools actually finish successfully. JSON includes elapsed opening time, the maximum and p99 event-loop intervals during opening and **each turn**, heap after forced GC and RSS before opening, after opening and at the end, and the bash turn's elapsed time and loop intervals. The 10 ms-resolution loop monitor adds a short settling delay outside each measured turn; intervals include scheduler noise and are not attributed CPU time.

This is a repeatable workload, **not a replica of the live process**. Print mode excludes machine/process sampling and interactive service integrations, the model makes no network requests, and it does not reproduce active workers or hours of timers. A passing result cannot establish live RSS, rule out stalls in other extensions, or prove a leak is absent. Compare the same input fingerprint, inspect the individual turns and repeat noisy comparisons rather than treating a single outlier as a causal improvement. Record attempts in `bench-session-results.md`.
