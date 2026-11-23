#!/usr/bin/env node

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { selectedProfileDir } from './selected-profile.mjs';

/** Default manifest filename stored in the active profile directory outside version control. */
export const DEFAULT_MANIFEST_FILENAME = 'change-manifest.json';

const SAFE_METRIC = /^[A-Za-z0-9._:/-]{1,120}$/;
const DIRECTIONS = new Set(['lower', 'higher']);
const USAGE = 'usage: change-manifest.mjs [--manifest ARQ] [--metrics-file ARQ] [--after NUM | --after METRICA=NUM] [--id ID] [--metric NOME] [--tolerance PCT] [--all] [--dry-run] [--json]';

class UsageError extends Error {}

const round6 = value => Math.round(value * 1e6) / 1e6;

function parseFiniteNumber(raw, label) {
  const text = String(raw).trim();
  if (!text) throw new UsageError(`${label} precisa de um número finito`);
  const num = Number(text);
  if (!Number.isFinite(num)) throw new UsageError(`${label} inválido: "${raw}"`);
  return num;
}

/** Resolves the default manifest path outside version control (respects SHIP_MANIFEST_PATH unless an explicit root is passed). */
export function defaultManifestPath(optchatHome) {
  if (optchatHome === undefined) {
    const override = process.env.SHIP_MANIFEST_PATH?.trim();
    if (override) return resolve(override);
  }
  return join(selectedProfileDir(optchatHome), DEFAULT_MANIFEST_FILENAME);
}

function extractSample(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return { value: raw };
  if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'value') && typeof raw.value === 'number' && Number.isFinite(raw.value)) {
    return {
      value: raw.value,
      ...(typeof raw.lowerIsBetter === 'boolean' ? { lowerIsBetter: raw.lowerIsBetter } : {}),
      ...(typeof raw.unit === 'string' && raw.unit ? { unit: raw.unit } : {}),
    };
  }
  return undefined;
}

/** Looks up a numeric metric in flat maps, bench-gate objects/arrays, or nested dotted JSON objects. */
export function readMetricValue(data, metric) {
  if (!metric || typeof metric !== 'string' || !data || typeof data !== 'object') return undefined;
  if (Array.isArray(data)) {
    const found = data.find(item => item && typeof item === 'object' && Object.hasOwn(item, 'metric') && item.metric === metric);
    return extractSample(found);
  }
  if (Object.hasOwn(data, 'metric') && data.metric === metric && Object.hasOwn(data, 'value')) {
    return extractSample(data);
  }
  if (Object.hasOwn(data, metric)) {
    const direct = extractSample(data[metric]);
    if (direct) return direct;
  }
  const parts = metric.split('.');
  let cur = data;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return extractSample(cur);
}

/** Reads a JSON metrics file and extracts a single finite numeric metric sample. */
export function readMetricFromFile(filePath, metric) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`não consegui ler métricas de ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const sample = readMetricValue(parsed, metric);
  if (!sample) throw new Error(`métrica "${metric}" ausente ou não numérica em ${filePath}`);
  return sample;
}

/** Reads the manifest JSON file; returns an empty v1 manifest when the file does not exist yet. */
export function readManifest(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { version: 1, entries: [] };
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`manifesto inválido em ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error(`manifesto em ${filePath} precisa de { version: 1, entries: [...] }`);
  }
  return parsed;
}

let tmpSeq = 0;

/** Writes the manifest JSON file atomically via a temporary file and rename. */
export function writeManifest(filePath, manifest) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${++tmpSeq}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

/** Records a shipped change and its target metric baseline in the manifest JSON file. */
export function recordChange(filePath, input) {
  const change = typeof input?.change === 'string' ? input.change.trim() : '';
  const metric = typeof input?.metric === 'string' ? input.metric.trim() : '';
  const direction = input?.direction ?? 'lower';
  if (!change) throw new Error('change é obrigatório para registrar no manifesto');
  if (!SAFE_METRIC.test(metric)) throw new Error(`métrica inválida: "${metric}"`);
  if (typeof input?.before !== 'number' || !Number.isFinite(input.before)) throw new Error('before precisa ser um número finito');
  if (!DIRECTIONS.has(direction)) throw new Error(`direction inválida: "${direction}" (use lower ou higher)`);

  const manifest = readManifest(filePath);
  const ref = input.pr !== undefined ? `pr-${Number(input.pr)}` : (input.commit || input.branch || 'change');
  const baseId = `${ref}:${metric}`;
  const pendingIndex = manifest.entries.findIndex(e => e.id === baseId && e.verdict === undefined);

  let id = baseId;
  if (pendingIndex < 0 && manifest.entries.some(e => e.id === id)) {
    let suffix = 2;
    while (manifest.entries.some(e => e.id === `${baseId}#${suffix}`)) suffix++;
    id = `${baseId}#${suffix}`;
  }

  const entry = {
    id,
    at: input.at ?? new Date().toISOString(),
    change,
    metric,
    before: input.before,
    direction,
    ...(typeof input.unit === 'string' && input.unit ? { unit: input.unit } : {}),
    ...(typeof input.branch === 'string' && input.branch ? { branch: input.branch } : {}),
    ...(typeof input.commit === 'string' && input.commit ? { commit: input.commit } : {}),
    ...(input.pr !== undefined ? { pr: Number(input.pr) } : {}),
    ...(typeof input.url === 'string' && input.url ? { url: input.url } : {}),
  };

  if (pendingIndex >= 0) manifest.entries[pendingIndex] = entry;
  else manifest.entries.push(entry);

  writeManifest(filePath, manifest);
  return { entry, path: filePath };
}

/** Compares before vs after for a metric direction and optional tolerancePct (default 0); worse than before returns REVERT. */
export function decideVerdict({ before, after, direction = 'lower', tolerancePct = 0 }) {
  if (typeof before !== 'number' || !Number.isFinite(before)) throw new Error('before precisa ser um número finito');
  if (typeof after !== 'number' || !Number.isFinite(after)) throw new Error('after precisa ser um número finito');
  if (!DIRECTIONS.has(direction)) throw new Error(`direction inválida: "${direction}"`);
  if (typeof tolerancePct !== 'number' || !Number.isFinite(tolerancePct) || tolerancePct < 0) {
    throw new Error('tolerancePct precisa ser um número >= 0');
  }
  const delta = round6(after - before);
  const margin = tolerancePct > 0 ? Math.abs(before) * (tolerancePct / 100) : 0;
  const worse = direction === 'lower' ? after > before + margin : after < before - margin;
  return { verdict: worse ? 'REVERT' : 'KEEP', delta, worse };
}

function revertSuggestion(entry) {
  if (entry.commit) return `git revert ${entry.commit}`;
  if (entry.pr !== undefined) return `revert PR #${entry.pr}`;
  return 'manual revert';
}

function lookupAfter(entry, options) {
  if (options.afterValues instanceof Map && options.afterValues.has(entry.metric)) {
    return options.afterValues.get(entry.metric);
  }
  if (options.afterValues && !(options.afterValues instanceof Map) && Object.hasOwn(options.afterValues, entry.metric)) {
    return options.afterValues[entry.metric];
  }
  if (options.afterValue !== undefined) return options.afterValue;
  if (options.metricsData !== undefined) return readMetricValue(options.metricsData, entry.metric)?.value;
  return undefined;
}

/** Evaluates manifest entries against after values, marking each KEEP or REVERT (suggestion only, never auto-reverts). */
export function evaluateManifest(filePath, options = {}) {
  const manifest = readManifest(filePath);
  const all = Boolean(options.all);
  const dryRun = Boolean(options.dryRun);
  const tolerancePct = options.tolerancePct ?? 0;
  const measuredAt = options.now ?? new Date().toISOString();

  const matches = entry => (!options.id || entry.id === options.id) && (!options.metric || entry.metric === options.metric);
  const matched = manifest.entries.filter(matches);
  const evaluable = matched.filter(entry => all || entry.verdict === undefined);

  if (options.afterValue !== undefined && !options.id && !options.metric) {
    const distinctMetrics = new Set(evaluable.map(entry => entry.metric));
    if (distinctMetrics.size > 1) {
      throw new UsageError('--after NUM é ambíguo para várias métricas; passe --after METRICA=NUM, --metric ou --id');
    }
  }

  let mutated = false;
  const results = [];
  for (const entry of matched) {
    const canEvaluate = all || entry.verdict === undefined;
    const after = canEvaluate ? lookupAfter(entry, options) : undefined;
    let current = entry;
    let evaluated = false;
    if (canEvaluate && typeof after === 'number' && Number.isFinite(after)) {
      const decision = decideVerdict({ before: entry.before, after, direction: entry.direction ?? 'lower', tolerancePct });
      current = { ...entry, after, delta: decision.delta, verdict: decision.verdict, measuredAt };
      const index = manifest.entries.indexOf(entry);
      if (index >= 0) manifest.entries[index] = current;
      mutated = true;
      evaluated = true;
    }
    const status = current.verdict ?? 'PENDING';
    results.push({
      id: current.id,
      status,
      evaluated,
      entry: current,
      ...(status === 'REVERT' ? { suggestion: revertSuggestion(current) } : {}),
    });
  }

  if (mutated && !dryRun) writeManifest(filePath, manifest);

  const summary = {
    total: results.length,
    keep: results.filter(r => r.status === 'KEEP').length,
    revert: results.filter(r => r.status === 'REVERT').length,
    pending: results.filter(r => r.status === 'PENDING').length,
  };
  return { path: filePath, entries: results, summary };
}

/** Formats verdict evaluation results into one readable KEEP/REVERT/PENDING line per entry. */
export function formatVerdicts(results) {
  if (!results.length) return 'no manifest entries';
  return results.map(r => {
    const { entry, status } = r;
    const unit = entry.unit ? ` ${entry.unit}` : '';
    if (status === 'PENDING') {
      return `PENDING ${entry.id}  ${entry.metric} before=${entry.before}${unit}  ${entry.change}`;
    }
    const delta = entry.delta ?? round6(entry.after - entry.before);
    const sign = delta > 0 ? '+' : '';
    const label = status === 'KEEP' ? 'KEEP  ' : 'REVERT';
    const hint = status === 'REVERT' && r.suggestion ? `  [suggestion: ${r.suggestion}]` : '';
    return `${label} ${entry.id}  ${entry.metric} ${entry.before} -> ${entry.after} (${sign}${delta}${unit})  ${entry.change}${hint}`;
  }).join('\n');
}

function parseCliArgs(argv) {
  const opts = {
    manifest: undefined,
    metricsFile: undefined,
    afterValues: new Map(),
    afterValue: undefined,
    id: undefined,
    metric: undefined,
    tolerancePct: 0,
    all: false,
    dryRun: false,
    json: false,
    help: false,
  };
  const nextValue = (flag, i, allowNegative = false) => {
    const val = argv[i + 1];
    if (val === undefined) throw new UsageError(`${flag} precisa de um valor`);
    if (val.startsWith('-') && !(allowNegative && /^-\d/.test(val))) throw new UsageError(`${flag} precisa de um valor`);
    return val;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--manifest') { opts.manifest = resolve(nextValue(arg, i)); i++; }
    else if (arg === '--metrics-file') { opts.metricsFile = resolve(nextValue(arg, i)); i++; }
    else if (arg === '--id') { opts.id = nextValue(arg, i); i++; }
    else if (arg === '--metric') { opts.metric = nextValue(arg, i); i++; }
    else if (arg === '--tolerance') {
      opts.tolerancePct = parseFiniteNumber(nextValue(arg, i), '--tolerance'); i++;
      if (opts.tolerancePct < 0) throw new UsageError('--tolerance precisa ser >= 0');
    } else if (arg === '--after') {
      const raw = nextValue(arg, i, true); i++;
      const eq = raw.indexOf('=');
      if (eq > 0) {
        const name = raw.slice(0, eq).trim();
        if (!SAFE_METRIC.test(name)) throw new UsageError(`métrica inválida em --after: "${name}"`);
        opts.afterValues.set(name, parseFiniteNumber(raw.slice(eq + 1), `--after ${name}`));
      } else {
        if (opts.afterValue !== undefined) throw new UsageError('--after NUM só pode ser usado uma vez; use --after METRICA=NUM');
        opts.afterValue = parseFiniteNumber(raw, '--after');
      }
    } else if (arg === '--all') opts.all = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else throw new UsageError(`opção desconhecida: ${arg}`);
  }
  return opts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.help) {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    let metricsData;
    if (opts.metricsFile) {
      try {
        metricsData = JSON.parse(readFileSync(opts.metricsFile, 'utf8'));
      } catch (error) {
        throw new UsageError(`não consegui ler ${opts.metricsFile}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const manifestPath = opts.manifest ?? defaultManifestPath();
    const result = evaluateManifest(manifestPath, {
      afterValues: opts.afterValues,
      afterValue: opts.afterValue,
      metricsData,
      id: opts.id,
      metric: opts.metric,
      tolerancePct: opts.tolerancePct,
      all: opts.all,
      dryRun: opts.dryRun,
    });
    if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`${formatVerdicts(result.entries)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UsageError) {
      process.stderr.write(`${message}\n${USAGE}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    }
  }
}
