# Benchmark Gate (`npm run bench:gate`)

Offline, zero-cost regression gate covering core `pi-optchat` performance points and providing a plugin directory for new metrics (such as the OpenHuman adoption plan items).

## Usage

```bash
# Run all plugins, write bench/latest.json, and compare against bench/baseline.json
npm run bench:gate

# Rewrite the baselines with the current measurements
npm run bench:gate -- --update

# Run a subset or override median sample runs per plugin
npm run bench:gate -- --filter=memory --runs=3
```

Sizes, counts and tokens are machine-independent and live in the committed `bench/baseline.json`. Timings and memory (`ms`, `MB`, `ms/MB`) depend on the machine, so `--update` writes them to the git-ignored `bench/baseline.local.json`; on a machine without one they show as `[NEW]` and do not gate.

Exit code is `0` when all metrics are within tolerance (or improved / new without baseline), and `1` when any metric regresses past its `tolerancePct`.

## Covered Plugins (`scripts/bench/`)

- `memory-175k.mjs`: `Memory.open` on 175,000 synthetic messages + binary tree (`--expose-gc`), median of 3 cycles (`memory.175k.rss_mb`, `heap_mb`, `open_ms`, `max_block_ms`).
- `prefix-tools.mjs`: Full extension tool declaration bytes/count + `assembleOfflineContext` sizes and timings (`prefix.*`, `context.*`).
- `output-preview.mjs`: `previewOutput` byte size and median latency on `log`, `diff`, and `search` fixtures.
- `context-projection.mjs`: `OutputContext` token savings, preview tokens, cold projection time, and `zoom` description bytes.
- `turn-start-and-cache.mjs`: Headless Pi session turn-start p50/p95 (`promptToProvider`, `wholeTurn`) and prompt-cache prefix stability (`prompt_cache.prefix_changes`).

## Adding a New Metric

Drop a `.mjs` or `.ts` file in `scripts/bench/<name>.mjs` that runs offline and prints JSON to stdout in one of these shapes:

```json
{ "metric": "openhuman.example_ms", "value": 12.3, "unit": "ms", "lowerIsBetter": true, "tolerancePct": 15 }
```

Arrays of metric objects or `{ [metric]: { value, unit, lowerIsBetter, tolerancePct? } }` maps are also accepted. `bench:gate` runs every file in `scripts/bench/` with `--experimental-transform-types --expose-gc`. New metrics without an entry in `bench/baseline.json` are reported as `[NEW]` and do not fail the gate until baselined with `--update`.
