# Reliability/performance pass (offline)

Scope: five requested areas beyond Pi-Ripwire. Existing checkout edits preserved. No paid inference, live account switching, commits, publication or deployment.

## Changes and acceptance evidence

| Area | Result | Evidence / limit |
|---|---|---|
| Tool reliability | Verified diagnostics improvement | Durable intent/response timestamps and `dispatchObserved` survive reopen. Actual Pi headless write test correlates dispatch/intent/response with independent file readback. Dispatch occurs before validation, so it is **not** proof the body ran. Errors/interruption/failed persistence retain replay barriers. Root cause of recurring harness outcome uncertainty remains unverified. |
| Context efficiency | Verified local CPU improvement | Immutable large outputs that cannot usefully be previewed are analyzed once with a WeakSet, rather than on every request. Original objects/text, recovery paths and instruction/history content remain unchanged. Optional numeric pre-provider payload bytes via `/optchat-perf payload on`; default off, `payload off` disables serialization. No raw payload retained. |
| Startup | Profiled; no verified gain | Trial deferring settings/browser imports measured 826.63 vs 824.34 ms (<1%, noise); reverted. Final unchanged-import benchmark varied 768.25 vs 817.09 ms (+6.4%); no startup speedup claim. This measures module import only; full interactive startup and its bottleneck are not measured. |
| Quota resilience | Verified offline | PMA now recognizes explicit `OPTCHAT_POLICY_REFUSAL` codes independent of message wording; red test reproduced a missed stop. Synthetic-provider Pi sessions test terminal refusal and two quota fallbacks followed by completion, without duplicate requests/account access. Live OAuth/quota eligibility not verified. |
| Regression benchmarks | Verified runnable | `npm run test:reliability`, `npm run benchmark:reliability -- <baseline-root>`, PMA `npm run test:recovery`; actual SDK tests, numerical reports and source/output identity assertions. Commands and privacy-safe crash diagnostics discoverable through local-validation skill. |

## Paired measurements

Windows Node v24.15.0, same toolchain, frozen pre-change source under ignored scratchpad. Alternating sample order, 9 samples ×100 repeated projections of the same immutable 250,000-byte tool result; one warmup per implementation. Assertions require the exact original message object on both sides.

- Repeated projection median: **0.581949 → 0.000134 ms per message** (about 99.98% less local work in this deliberately repeated fixture).
- Context bytes unchanged. This is reuse of an already analyzed message, not first-pass speed, token savings, model latency or improved reasoning.
- Startup: 7 fresh subprocess imports per source. Results above are noisy and do not establish an improvement. No import deferral retained.

Raw samples/baseline: `scratchpad/reliability-performance/paired-final.txt` and `baseline/` (ignored, not release artifacts). `benchmark:reliability` without a baseline only performs current/current smoke; it is not improvement evidence.

## Native crash investigation

Bounded metadata-only inspection found one existing ProcDump file with exception `0xc0000409`, fast-fail subcode **2** (stack-cookie check failure), site `node.exe+0x21f2189`. Reader consumed 620 bytes, not the 846 MB memory dump. A second termination dump had no exception stream (260 bytes read), so it is not counted as a second crash.

The exception site does not identify where corruption originated. No debugger was found on PATH or in the standard Windows SDK debugger locations. Native causal diagnosis requires a compatible debugger/symbols; no machine-wide debugger installed. Dumps remain private and untouched.

Reusable reader: dotfiles `payload/pi/agent/bin/pi-crash-metadata.js`, installed in the per-user Pi bin directory. Four synthetic tests validate bounds, repeated unused stream entries, basename-only output and exclusion of memory contents. Fresh Pi skill discovery finds expanded triggers with zero diagnostics and resolves the guide from dotfiles.

## Verification

- OptChat typecheck passed; complete suite **478 passed, 1 skipped, 0 failed**; Pi 1.2 compatibility **2/2**.
- `test:reliability` **26/26**.
- PMA typecheck passed; complete suite **728 passed, 1 skipped, 0 failed**; recovery entrypoint **7/7**. Broader recovery/failover selection **455/455** earlier in the pass.
- Crash metadata tests **4/4**, plus inspection of both real local dumps without reading memory streams.
- Focused Ripwire edit checks passed. PMA and dotfiles quality delta passed; dotfiles test-gate passed. OptChat whole-dirty-tree quality delta remains exit 2 with 18 major findings, and OptChat/PMA test-gates exit 4. These are not clean static gates; dynamic lifecycle/runner mappings limit them. Existing aggregate findings are outside this focused pass; no test/type/security weakening applied.
- Diff review against the preserved pre-pass source confirms only intended production changes. Existing line-ending warnings remain.

Reload required for live extensions. Root uncertainty, native cause, live quota state and whole-agent gains remain unverified, not implied by offline test success.
