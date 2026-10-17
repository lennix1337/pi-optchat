> Updated outcome: see [the final optimization report](optchat-optimization-report.md). The full 20-attempt real-harness campaign, candidate grade, quote-aware diagnostic repair, quota blocker and final verification supersede this earlier first-pair status.

# Real OptChat harness and first product optimization

## Scope

The earlier bare-Pi SWE-bench receipts are **not** an OptChat baseline. Their 7 resolved / 2 failed / 1 inconclusive result remains unchanged. This work does not improve that score or establish a provider-cache or end-to-end speed gain.

## Real runtime: verified offline

The actual OptChat extension now runs inside Docker, not on the host with a container-only replacement tool. A disposable profile enables its real tools, memory, context projection, compactor and recovery handlers. The fixture model performs:

1. A real `write` call inside the container.
2. A real `read` and a following request containing the resulting file contents.
3. A real `bash` call producing a large log and exit code 7.
4. OptChat's production recoverable-output projection, followed by `output_read` retrieving the original sentinel.
5. A final response after these four tool round trips.

This passed both on `node:22-slim` (initial write/read probe) and on the official Requests SWE-bench task image with the Node/OptChat runtime overlaid. The final task-image probe made five main requests and three real OptChat compactor requests to a synthetic provider. The compactor was not silently replaced with bare Pi or disabled in the extension.

Actual Docker inspection verified: network `none`, 4 CPUs, 4 GiB memory and swap cap, no host mounts, dropped capabilities, and read-only root filesystem for the functional probe. Unique task-created containers and images were removed. The unrelated GitHub MCP service stayed running. This shared-host **functional smoke is not a performance benchmark**.

### Credential boundary

`optchat-model-bridge.ts` and `optchat-container-transport.ts` connect the isolated runtime to a model-event pipe. The host forwards only model requests/responses; it does not execute model tool calls. Only public model metadata enters the container. Credentials, provider headers, login configuration, account files and the user's actual conversation are not copied.

Reasoning, cache retention, transport, tool choice and generation limits are forwarded through an explicit allowlist. Request keys are stable per logical session within a task. Failure/disconnection/cancellation blocks replay. Host-side errors omit raw provider diagnostics and retain attempted-request evidence. A 60-second response deadline, 20-minute task deadline and 64-request cap bound live pilots. No automatic retry or account switching.

The adapter is currently for the selected Codex comparison, not a claim of arbitrary-provider equivalence: provider-specific callback functions are not serialized across the pipe. Both variants use the same bridge and explicit role/model configuration. Container networking remains disabled; OAuth refresh and authenticated dispatch happen only on the host through Pi's native account-2 runtime.

## Actual product optimization

`src/output-preview.ts:previewOutput` previously selected log/diff/search lines twice: once to count omissions and again to render them. It now computes that selection once and reuses it. No prompt, token budget, recovery safeguard, original retention, or preview content changed.

An alternating-order, same-process comparison used 41 paired samples, three calls per sample, after warm-up. All result objects and output digests were identical.

| Production component fixture | Before median | After median | Reduction |
|---|---:|---:|---:|
| 889,096-byte log | 4.896 ms | 4.238 ms | 13.45% |
| 415,622-byte diff | 5.262 ms | 3.070 ms | 41.67% |
| 517,783-byte search | 5.472 ms | 3.885 ms | 29.01% |

P90 also improved on all three fixtures. These are **local component CPU-time measurements with synthetic inputs on a shared host**, not overall OptChat latency, cache hit rate, task correctness, or quota savings. Absolute savings are about 0.66–2.19 ms per first preview in these fixtures. Cached projections need not rerun this component. Do not extrapolate these percentages to the whole agent.

Raw measurement: `optchat-preview-once.json`. Before-source SHA-256: `5e9a037d582a1ddbc8b6a47ef133c42dbedbc554800c73351e6b2b5e7caeb2ea`; after: `7d33b2055bbb7974263f7108ece21efa7c0ee73c23b5115354e87df35150b744`.

## Live comparison: first real pilot pair, broader evaluation pending

`test/optchat-real-benchmark.ts` stages frozen, fingerprinted runtime snapshots and uses the same real container harness for baseline and candidate. It validates an official task manifest, account-2 OAuth eligibility, active OptChat tools/model/thinking, clean task checkout, and actual container isolation before forwarding the first model request. Task containers allow their own filesystem writes so the real tools can edit `/testbed`; no host filesystem is mounted. Patch capture includes new files and disables external diff drivers. Receipts retain source hashes, usage, timing, cache traces, OOM/state, patch and cleanup evidence. Failed runs are not replayed.

The initial exclusive-slot attempt was blocked before inference (`scratchpad/real-optchat-pilot-sTWO4T/receipt.json`). Investigation identified the other container as an idle infrastructure service, not a benchmark. The new real-OptChat protocol explicitly records this shared-host condition for **both** variants: only `ghcr.io/github/github-mcp-server` at at most 1% CPU may coexist; unknown workloads still block, as does less than 5 GiB free RAM. The service is never stopped. This changes the protocol; results are not comparable to earlier exclusive-slot/bare-Pi runs.

One genuine account-2/Luna/high Requests task pair ran in the whole OptChat harness. Baseline and candidate produced byte-identical 588-byte patches. Candidate generation completed; correctness is not graded. Baseline captured its complete main result/patch and container exit 0, but the transport incorrectly treated shutdown cancellation of a background compactor request as a run failure. Its original failed receipt is preserved, not relabeled or replayed. An offline regression now verifies orderly cancellation separately from actual provider errors.

Artifacts: baseline `scratchpad/real-optchat-pilot-aRAqdG/receipt.json`; candidate `scratchpad/real-optchat-pilot-dswSQ7/receipt.json`. Both report no OOM and successful cleanup. Candidate took 82.79 s versus baseline's 157.32 s including setup; different model tool-call counts and the baseline finalization defect make this **not an attributable speedup**. Main-call cache-read was 63.45% versus 68.67%, so no cache improvement was demonstrated. Concurrent compactor traces had an attribution bug; use keyed request usage as evidence, not those original concurrent trace aggregates. Request-indexed attribution now has an offline regression.

## Verification

- TypeScript and focused model-bridge/runtime-snapshot tests passed.
- Full suite: 467 passed, 1 skipped, zero failures.
- Pi 1.2 compatibility: 2/2.
- Docker command/staging/gate tests: 3/3.
- Official task-image bridge smoke: verified five main requests, three compactor requests, four real tool round trips, retrieval of the original log, and cleanup.
- Ripwire edit checks passed. Repository-wide quality-delta and test-gate remain non-green; do not call them passing or assume all findings predate this work. The new receipt-writing helper also triggers a small clone warning against existing JSON persistence code.
- Two live task generations used the selected Pi OAuth account (no API-key billing); no grading, credential export, account switch, commit, push or deployment. The initial blocked attempt spent no inference quota.

## Reproduction

```sh
npm run check
npm test
npm run test:pi-compat
node --test test/optchat-container-smoke.test.mjs
node --import tsx test/optchat-bridge-smoke.ts --task-image swebench/sweb.eval.x86_64.psf_1776_requests-5414:latest
# Baseline module must be the preserved before-source file:
node --import tsx test/output-preview-benchmark.ts scratchpad/output-preview-before-once.ts
# Freeze current runtime without inference:
node --import tsx test/optchat-real-benchmark.ts --snapshot
# Live only after resolving the recorded protocol blocker:
node --import tsx test/optchat-real-benchmark.ts --run --tasks-file scratchpad/openhuman-fixtures/tasks.json --task psf__requests-5414 --source <frozen-runtime-directory>
```

The broader goal remains pending: a valid real-model OptChat baseline/candidate comparison, independent correctness evaluation, and any measured cache/latency/quality improvement beyond this narrow component optimization. No new claim of 10/10 correctness or an improved SWE score is justified.
