# Cache baseline optimization — 2026-10-16

## Objective and acceptance

Investigate the cache gap against the user's 96.6% long-chat footer, optimize the bare Pi baseline without padding prompts, preserve model/account/task/resource settings and every original result. Keep a candidate only if measured uncached input/latency improve without correctness regressions. A single ungraded pilot cannot establish that criterion. No commits/pushes or reference patches.

## Audit (verified)

`cache-baseline-audit.json` derives all 82 provider responses from the ten original receipts:

- All ten tasks: 127,788 uncached input + 162,176 cache-read = **55.93%** cached.
- The comparison's **61.34%** is the seven-resolved-task subset, not all ten.
- Ten first requests account for 10,839 uncached tokens. **27 later requests also reported zero cache**, so cold starts alone do not explain the gap.
- Long-chat cumulative footer usage and short fresh-task usage are different workloads. Increasing context or adding warmup calls merely to increase a ratio is not an optimization.

The official OpenAI API [cache guide](https://developers.openai.com/api/docs/guides/prompt-caching) describes prefix matching, minimum cache lengths and non-guaranteed cache availability. The Codex subscription endpoint is not identical to the public API; do not inject undocumented cache options or promise API-only behavior here.

## Instrumentation (implemented)

`test/benchmark-cache.ts` records hashes of instructions, tools, cache key and each input item; common prefix length; per-response provider usage and payload-to-message-end elapsed time. It records no raw prompts/keys. Receipts still preserve generated patches as before. This is not TTFT, CPU measurement or token-exact prefix analysis.

## Experiments

1. Instrumented unchanged baseline, `sympy__sympy-16766`: 6 responses, **69.05% cache**, 6,654 uncached input tokens, 668 output tokens, **28.093 s**, completed but **ungraded**. Instructions, tools, cache key and all earlier input items stayed identical between requests. This establishes no gain over the historical 41.01% run: generations and provider cache availability vary.
2. `container-v1`: replaced irrelevant generic Pi/host prompt with task-specific verification guidance. **Rejected**: timed out at 1,211.748 s, 28.07% cache, 16,730 uncached input; provider reported 128,716 output tokens, including 128,000 in one response. Receipt and patch preserved; cleanup succeeded; no observed OOM. Exact cause of excessive output unestablished. Prompt removed from executable code.
3. `container-lean-v2`: screening candidate removes generic Pi docs/host paths only, with concise container instructions. Opt-in only. **Blocked before inference**: preflight found an already-running unrelated Docker container (`f01e5d3d7f94`, `gracious_liskov`). Free host memory was 8,879,504 KiB, above the 5-GiB generation gate; Docker isolation, not RAM, blocked this trial. The existing container was not stopped or modified. No candidate result or improvement is claimed.

Raw receipts and SHA-256 are under `cache-experiments/`. No pilot has been officially graded. The original ten-task benchmark remains untouched.

## Runaway safeguard

Future experiments enforce a **60-second per-provider-response watchdog**, in addition to the existing 20-minute task timer. This is an explicitly changed experimental protocol, not the old official baseline. It aborts and prevents further requests after expiry; does not time tool execution; is not a hard token cap. Codex's installed provider does not serialize a `maxTokens` limit, so silently setting that option would not solve this. Safety unit tests verify expiry, no restart and timer cleanup. No automatic retries/account switches.

## Next

When Docker is free of unrelated work, screen lean-v2 once using `PI_BENCHMARK_PROMPT_VARIANT=container-lean-v2 node scratchpad/openhuman-fixtures/cache-pilot.mjs` from the repository, under the 5-GiB generation gate, same account-2/Luna/high/4-GiB task settings and new response safeguard. Reject on timeout or worse input usage; no unsupported cache-mode changes. Require repeated paired measurements and independent tests before adopting any prompt change. Official grading still requires the separate 12-GiB RAM gate. Do not stop someone else's container to make this run.

## Validation/status

- **Verified:** receipt audit; same-task unchanged baseline request trace; failed candidate evidence/cleanup; TypeScript; focused tests (18/18); full suite (455 passed, 1 skipped); whitespace check.
- **Not verified:** a cache-speed improvement; lean-v2 effectiveness; correctness of new pilot patches (not graded); raw cause of 128,000-token provider response.
- **Blocked:** isolated next live pilot while unrelated container is running. No Git publication or machine/browser configuration changes.
- Ripwire edit-check reports the pre-existing untracked runner as a new symbol with no incompatible callers. Whole-dirty-tree quality/test gates remain non-green; they do not replace the actual passing test executions. Artifacts: `scratchpad/cache-edit-check.txt`, `scratchpad/cache-quality.txt`, `scratchpad/cache-test-gate.txt`.
