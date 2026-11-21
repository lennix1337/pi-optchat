import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface MetricSample {
  value: number;
  unit: string;
  lowerIsBetter: boolean;
  tolerancePct?: number;
  runs?: number;
}

export interface BaselineEntry {
  value: number;
  unit: string;
  lowerIsBetter: boolean;
  tolerancePct?: number;
  runs?: number;
}

export type MetricsMap = Record<string, MetricSample>;
export type BaselineMap = Record<string, BaselineEntry>;

export interface MetricComparison {
  metric: string;
  status: 'ok' | 'improved' | 'regressed' | 'new';
  current: number;
  baseline?: number;
  unit: string;
  lowerIsBetter: boolean;
  tolerancePct?: number;
  deltaPct?: number;
}

export interface CompareResult {
  passed: boolean;
  comparisons: MetricComparison[];
  regressed: MetricComparison[];
  improved: MetricComparison[];
  added: MetricComparison[];
}

export const DEFAULT_TOLERANCE_PCT = 5;


const MACHINE_UNITS = new Set(['ms', 'MB', 'ms/MB']);

export function isMachineMetric(entry: { unit: string }): boolean {
  return MACHINE_UNITS.has(entry.unit);
}

/** Splits a baseline into the committed part (sizes, counts) and the per-machine part (timings, memory). */
export function splitBaseline(baseline: BaselineMap): { shared: BaselineMap; machine: BaselineMap } {
  const shared: BaselineMap = {};
  const machine: BaselineMap = {};
  for (const [metric, entry] of Object.entries(baseline)) {
    (isMachineMetric(entry) ? machine : shared)[metric] = entry;
  }
  return { shared, machine };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median requires at least one value');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Normalizes stdout JSON from a scripts/bench/* plugin into a flat MetricsMap.
 * Supports:
 * - Single metric object: { metric, value, unit, lowerIsBetter, tolerancePct? }
 * - Array of metric objects: [{ metric, value, unit, lowerIsBetter, ... }, ...]
 * - Map of metrics: { [metric]: { value, unit, lowerIsBetter, tolerancePct? } }
 */
export function normalizePluginOutput(raw: unknown, sourceLabel = 'plugin'): MetricsMap {
  const out: MetricsMap = {};
  const add = (name: string, entry: Record<string, unknown>) => {
    if (typeof entry.value !== 'number' || !Number.isFinite(entry.value)) {
      throw new Error(`${sourceLabel}: metric "${name}" has invalid value`);
    }
    if (typeof entry.unit !== 'string' || !entry.unit) {
      throw new Error(`${sourceLabel}: metric "${name}" is missing unit`);
    }
    if (typeof entry.lowerIsBetter !== 'boolean') {
      throw new Error(`${sourceLabel}: metric "${name}" is missing boolean lowerIsBetter`);
    }
    out[name] = {
      value: entry.value,
      unit: entry.unit,
      lowerIsBetter: entry.lowerIsBetter,
      ...(typeof entry.tolerancePct === 'number' ? { tolerancePct: entry.tolerancePct } : {}),
      ...(typeof entry.runs === 'number' && entry.runs > 1 ? { runs: Math.floor(entry.runs) } : {}),
    };
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object' || typeof (item as Record<string, unknown>).metric !== 'string') {
        throw new Error(`${sourceLabel}: array item must have string "metric"`);
      }
      const record = item as Record<string, unknown>;
      add(record.metric as string, record);
    }
    return out;
  }

  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    if (typeof record.metric === 'string' && 'value' in record) {
      add(record.metric, record);
      return out;
    }
    for (const [key, value] of Object.entries(record)) {
      if (!value || typeof value !== 'object') {
        throw new Error(`${sourceLabel}: metric "${key}" must be an object`);
      }
      add(key, value as Record<string, unknown>);
    }
    return out;
  }

  throw new Error(`${sourceLabel}: expected JSON object or array`);
}

export function compareMetrics(
  current: MetricsMap,
  baseline: BaselineMap,
  defaultTolerancePct = DEFAULT_TOLERANCE_PCT,
): CompareResult {
  const comparisons: MetricComparison[] = [];
  const regressed: MetricComparison[] = [];
  const improved: MetricComparison[] = [];
  const added: MetricComparison[] = [];

  for (const metric of Object.keys(current).sort()) {
    const curr = current[metric]!;
    const base = baseline[metric];
    if (!base) {
      const item: MetricComparison = {
        metric,
        status: 'new',
        current: curr.value,
        unit: curr.unit,
        lowerIsBetter: curr.lowerIsBetter,
      };
      comparisons.push(item);
      added.push(item);
      continue;
    }

    const tol = base.tolerancePct ?? curr.tolerancePct ?? defaultTolerancePct;
    const lower = base.lowerIsBetter;
    const deltaPct = base.value === 0
      ? (curr.value === 0 ? 0 : (curr.value > 0 ? 100 : -100))
      : ((curr.value - base.value) / Math.abs(base.value)) * 100;

    let status: MetricComparison['status'] = 'ok';
    if (lower) {
      const limit = base.value === 0 ? 0 : base.value * (1 + tol / 100);
      if (curr.value > limit) status = 'regressed';
      else if (curr.value < base.value) status = 'improved';
    } else {
      const limit = base.value === 0 ? 0 : base.value * (1 - tol / 100);
      if (curr.value < limit) status = 'regressed';
      else if (curr.value > base.value) status = 'improved';
    }

    const item: MetricComparison = {
      metric,
      status,
      current: curr.value,
      baseline: base.value,
      unit: curr.unit,
      lowerIsBetter: lower,
      tolerancePct: tol,
      deltaPct: Math.round(deltaPct * 100) / 100,
    };
    comparisons.push(item);
    if (status === 'regressed') regressed.push(item);
    else if (status === 'improved') improved.push(item);
  }

  return {
    passed: regressed.length === 0,
    comparisons,
    regressed,
    improved,
    added,
  };
}

export function buildUpdatedBaseline(
  current: MetricsMap,
  existing: BaselineMap,
  defaultTolerancePct = DEFAULT_TOLERANCE_PCT,
): BaselineMap {
  const next: BaselineMap = {};
  for (const metric of Object.keys(current).sort()) {
    const curr = current[metric]!;
    const prev = existing[metric];
    next[metric] = {
      value: curr.value,
      unit: curr.unit,
      lowerIsBetter: curr.lowerIsBetter,
      tolerancePct: prev?.tolerancePct ?? curr.tolerancePct ?? defaultTolerancePct,
      ...((prev?.runs ?? curr.runs) ? { runs: prev?.runs ?? curr.runs } : {}),
    };
  }
  return next;
}

function parseJsonStdout(stdout: string, label: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error(`${label}: empty stdout`);
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]!);
      } catch {

      }
    }
    throw new Error(`${label}: could not parse JSON from stdout:\n${trimmed.slice(-500)}`);
  }
}

function runPluginOnce(filePath: string): MetricsMap {
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--expose-gc', '--no-warnings', filePath],
    {
      encoding: 'utf8',
      timeout: 110_000,
      env: { ...process.env, CI: '1', PI_OFFLINE: '1', PI_TELEMETRY: '0' },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${filePath} exited with ${result.status}\n${result.stderr || result.stdout}`);
  }
  return normalizePluginOutput(parseJsonStdout(result.stdout, filePath), filePath);
}

function runPluginWithMedian(filePath: string, forcedRuns: number | undefined, baseline: BaselineMap): MetricsMap {
  const first = runPluginOnce(filePath);
  const requestedRuns = forcedRuns ?? Math.max(
    1,
    ...Object.entries(first).map(([name, m]) => baseline[name]?.runs ?? m.runs ?? 1),
  );
  if (requestedRuns <= 1) return first;
  const samples: MetricsMap[] = [first];
  for (let i = 1; i < requestedRuns; i++) samples.push(runPluginOnce(filePath));
  const aggregated: MetricsMap = {};
  for (const [metric, meta] of Object.entries(first)) {
    const values = samples.map(s => {
      const item = s[metric];
      if (!item) throw new Error(`${filePath}: missing metric ${metric} on run`);
      return item.value;
    });
    aggregated[metric] = { ...meta, value: Math.round(median(values) * 1000) / 1000 };
  }
  return aggregated;
}

function formatReport(compare: CompareResult): string {
  const lines: string[] = [];
  for (const c of compare.comparisons) {
    const dir = c.lowerIsBetter ? 'lower' : 'higher';
    if (c.status === 'new') {
      lines.push(`  [NEW]       ${c.metric}: ${c.current} ${c.unit} (${dir} is better)`);
    } else {
      const sign = (c.deltaPct ?? 0) >= 0 ? '+' : '';
      const tag = c.status === 'regressed' ? '[REGRESSED]' : c.status === 'improved' ? '[IMPROVED] ' : '[OK]       ';
      lines.push(`  ${tag} ${c.metric}: ${c.current} ${c.unit} vs ${c.baseline} ${c.unit} (${sign}${c.deltaPct}%, tol ±${c.tolerancePct}%, ${dir})`);
    }
  }
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const runsArg = args.find(a => a.startsWith('--runs='))?.split('=')[1];
  const forcedRuns = runsArg ? Number(runsArg) : undefined;
  const filterArg = args.find(a => a.startsWith('--filter='))?.split('=')[1];

  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const benchDir = join(root, 'scripts', 'bench');
  const baselinePath = join(root, 'bench', 'baseline.json');
  const machineBaselinePath = join(root, 'bench', 'baseline.local.json');
  const latestPath = join(root, 'bench', 'latest.json');

  const readBaseline = (path: string): BaselineMap =>
    existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as BaselineMap : {};
  const existingBaseline: BaselineMap = {
    ...splitBaseline(readBaseline(baselinePath)).shared,
    ...splitBaseline(readBaseline(machineBaselinePath)).machine,
  };

  const plugins = readdirSync(benchDir)
    .filter(name => (name.endsWith('.mjs') || name.endsWith('.ts')) && (!filterArg || name.includes(filterArg)))
    .sort();

  if (plugins.length === 0) {
    console.error('No benchmark plugins found in scripts/bench/');
    process.exit(1);
  }

  const allMetrics: MetricsMap = {};
  for (const plugin of plugins) {
    const fullPath = join(benchDir, plugin);
    process.stderr.write(`Running ${plugin}...\n`);
    const metrics = runPluginWithMedian(fullPath, forcedRuns, existingBaseline);
    Object.assign(allMetrics, metrics);
  }

  const latestJson: Record<string, { value: number; unit: string; lowerIsBetter: boolean }> = {};
  for (const metric of Object.keys(allMetrics).sort()) {
    const m = allMetrics[metric]!;
    latestJson[metric] = { value: m.value, unit: m.unit, lowerIsBetter: m.lowerIsBetter };
  }
  mkdirSync(dirname(latestPath), { recursive: true });
  writeFileSync(latestPath, JSON.stringify(latestJson, null, 2) + '\n');

  if (update) {
    const updated = buildUpdatedBaseline(allMetrics, existingBaseline);
    const { shared, machine } = splitBaseline(updated);
    writeFileSync(baselinePath, JSON.stringify(shared, null, 2) + '\n');
    writeFileSync(machineBaselinePath, JSON.stringify(machine, null, 2) + '\n');
    console.log(`Updated ${baselinePath} (${Object.keys(shared).length}) and ${machineBaselinePath} (${Object.keys(machine).length}):`);
    for (const metric of Object.keys(updated).sort()) {
      const m = updated[metric]!;
      console.log(`  ${metric}: ${m.value} ${m.unit} (lowerIsBetter=${m.lowerIsBetter}, tol=${m.tolerancePct}%)`);
    }
    return;
  }

  const comparison = compareMetrics(allMetrics, existingBaseline);
  console.log(formatReport(comparison));

  if (!comparison.passed) {
    console.error(`\nBenchmark gate FAILED (${comparison.regressed.length} regressed):`);
    for (const r of comparison.regressed) {
      console.error(`  - ${r.metric}: ${r.current} ${r.unit} vs baseline ${r.baseline} ${r.unit} (${r.deltaPct}%, tol ${r.tolerancePct}%)`);
    }
    process.exit(1);
  }
  console.log(`\nBenchmark gate PASSED (${comparison.comparisons.length} metrics, ${comparison.improved.length} improved, ${comparison.added.length} new).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
