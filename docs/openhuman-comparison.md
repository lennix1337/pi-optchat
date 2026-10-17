# Pi account SWE-bench path vs. OpenHuman

## Purpose and current status

`test/pi-account-benchmark.ts` is an opt-in path to run an OpenHuman-prepared SWE-bench task with the locally logged-in Pi subscription. It is **not** the OpenHuman harness, an OptChat extension benchmark, or a reproduction of OpenHuman's published scores. No inference or grading result is claimed here.

The fixed 10-task fixtures are at `scratchpad/openhuman-fixtures/tasks.json`; their source revision, IDs, prompt hashes, and setup are recorded in [`swe-fixture-preflight.md`](swe-fixture-preflight.md). The task manifest and `prompt.txt` are passed through without changing their prompt text. Grader revision pinning is being handled separately and is not verified by this runner.

## Safe invocation

Run the no-inference preflight first:

```sh
node --import tsx test/pi-account-benchmark.ts --preflight
```

It resolves the explicit user-selected `openai-codex-account-2/gpt-6-luna`, checks the registered model and OAuth/subscription metadata, creates only a local no-tools Pi session to report the effective reasoning level, and performs no model request or model-catalog network refresh. `lastSelectedOptChatProfile` is informational only; a standalone process cannot prove which profile is active in a separate interactive Pi session.

A task command is a real inference run and must be used only after coordinator review and a passing host resource gate:

```sh
node --import tsx test/pi-account-benchmark.ts \
  --tasks-file scratchpad/openhuman-fixtures/tasks.json \
  --task psf__requests-5414
```

Run one task per invocation. The runner rejects API-key auth and requires Pi to report a stored OAuth subscription credential for `openai-codex-account-2`. Base-provider credentials are not a fallback. Credentials stay in the host Pi runtime and are never passed to Docker. The agent session uses **bare Pi SDK** with OptChat extensions, project context, skills, and built-in tools disabled; its only tool is a host-side `docker exec` bridge into `/testbed`. This measures that bare Pi coding-agent setup, not OptChat's memory/profile/tool optimizations.

The container uses the exact manifest image with `--pull=never`, 4 CPUs, **4 GiB memory (user-approved lower-memory variant)**, no swap, 4096 PIDs, `--network=none`, and no host bind mounts. The requested model call remains on the host, outside the task container. The runbook task timeout is 1200 seconds; timeout/cancellation and cleanup outcomes are written as receipts under the OS temporary directory, including a captured patch when available. The printed receipt path is needed to retain or grade that patch. The runner itself does not invoke the official grader.

**The user approved a lower-memory protocol instead of the original 12 GB-free host gate.** Run sequentially with a 4 GiB container cap and at least 5 GiB free host RAM before each task (4 GiB task plus 1 GiB headroom). This threshold is a local safeguard, not a measured requirement. Latest pre-run snapshot: 9.49 GiB free. Isolation/clean-baseline Docker smoke, TypeScript and 14 runner tests passed. `scratchpad/openhuman-fixtures/run-low-memory.mjs` saves per-task evidence and stops on failures without retries or account switching. Containers persist until explicit cleanup to capture OOM state; receipts include provider response counts, reported usage and memory state. Preflight/local tests make no model requests.

## Method differences from published OpenHuman results

OpenHuman's [published benchmark report](https://tinyhumansai.github.io/openhuman-benchmarks/) follows its [runbook](https://github.com/tinyhumansai/openhuman-benchmarks/blob/main/RUNBOOK.md): its controlled SWE-bench sample uses `deepseek/deepseek-v4.1-flash`, provider `DeepSeek`, `reasoning: high`, an OpenRouter metering proxy/key, the fixed task list and prompt wrapper, 4-CPU/8-GB/no-swap task limits, and the official `swebench.harness.run_evaluation` grader. The proxy records provider requests, latency, token/cache usage, and cost.

This Pi path differs in material ways:

- **Model/provider/auth:** it explicitly requests `openai-codex-account-2/gpt-6-luna` via the Pi subscription OAuth flow, not DeepSeek V4.1 Flash through OpenRouter. High reasoning is requested, but the receipt records Pi's effective level and supported levels; provider settings are not assumed equivalent.
- **Metering:** there is no OpenRouter proxy or per-call cost/cache meter. Subscription usage cannot be reported as OpenRouter dollar cost or compared on cost-per-solved-task.
- **Harness:** this is a bare Pi SDK session with only the container executor, not OpenHuman's adapter or a cross-harness Pi/OptChat adapter. Do not attribute its results to OptChat.
- **Isolation/network:** CPU matches the runbook but task memory is **4 GiB instead of 8 GiB**; this runner also disables container networking and host mounts; OpenHuman's benchmark harness communicates through its metering setup. The host-side Pi request is not made from the task container.
- **Evaluation/reporting:** this runner captures a task patch and receipt but does not invoke OpenHuman's grading/report pipeline. The fixture's grader-revision pin is still pending independent verification.

Therefore, even if the same 10 task IDs and prompts are used, a resolve rate from this runner would be a separate experiment, **not directly comparable or equivalent** to OpenHuman's published numbers. A valid comparison requires matching the model/provider, reasoning behavior, metering, harness, environment, pinned grading revision, and official evaluation protocol.

## Verification commands

```sh
node --import tsx --test test/pi-account-benchmark.test.ts
npx tsc --noEmit
```

These are local code checks only; they do not run Docker tasks, make model requests, or grade patches.