import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { githubMerges, mergesFromFile, readCostLedger, repoBranch, repoPattern, runBranches, sessionEvidence, type Delivery, type Row } from './cost-delivery-sources.ts';

const tokenKeys = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
type Rate = Record<typeof tokenKeys[number], number> & { provider: string; modelPrefix: string; reference: string };
type Config = { prices: Rate[]; deployRepo?: string; githubScope?: string; sessionsDir?: string; weekly?: boolean };
export const agentDir = () => process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');

function optionalJson(path: string, required: boolean) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (required || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return {}; }
}

function loadConfig(dir: string, path?: string): Config {
  const defaults = JSON.parse(readFileSync(new URL('./cost-rates.json', import.meta.url), 'utf8')) as Config;
  const config = optionalJson(path ?? join(dir, 'cost-report.json'), !!path) as Partial<Config>;
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.weekly !== undefined && typeof config.weekly !== 'boolean') ||
    (config.deployRepo !== undefined && (typeof config.deployRepo !== 'string' || !repoPattern.test(config.deployRepo))) ||
    (config.sessionsDir !== undefined && (typeof config.sessionsDir !== 'string' || !config.sessionsDir)) ||
    (config.githubScope !== undefined && (typeof config.githubScope !== 'string' || !/^(?:author:@me|(?:repo:[\w.-]+\/[\w.-]+)(?: repo:[\w.-]+\/[\w.-]+)*)$/.test(config.githubScope)))) throw new Error('Configuração inválida do relatório de custo.');
  const prices = config.prices ?? defaults.prices;
  if (!Array.isArray(prices) || prices.some(p => !p || !['provider', 'modelPrefix', 'reference'].every(k => typeof p[k as keyof Rate] === 'string' && p[k as keyof Rate]) ||
    tokenKeys.some(k => !Number.isFinite(p[k]) || p[k] < 0) || tokenKeys.every(k => p[k] === 0))) throw new Error('Tabela de preços inválida.');
  return { ...config, prices: [...prices].sort((a, b) => b.modelPrefix.length - a.modelPrefix.length) };
}

export function dateKey(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const offsetDay = (at: number, days: number) => {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
};
function period(week: string | undefined, now: number, completed: boolean) {
  if (!week) return { from: offsetDay(now, completed ? -7 : -6), to: completed ? offsetDay(now, 0) : now };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error('Use --week YYYY-MM-DD (primeiro dia da semana).');
  const from = new Date(`${week}T00:00:00`).getTime();
  if (!Number.isFinite(from) || dateKey(from) !== week || from > now) throw new Error('Início de semana inválido ou futuro.');
  return { from, to: Math.min(offsetDay(from, 7), now) };
}

const zero = () => ({ known: 0, unknown: 0, tokens: 0, calls: 0 });
type Total = ReturnType<typeof zero>;
const keyTotal = (map: Map<string, Total>, key: string) => {
  let total = map.get(key);
  if (!total) { total = zero(); map.set(key, total); }
  return total;
};
const agyReason = 'agy: faltam tokens de entrada, saída, leitura e gravação de cache por chamada (a cota percentual não é uma contagem)';
const providerOf = (row: Row) => row.provider || 'conta desconhecida';
function rateCost(row: Row, prices: Rate[]) {
  if (row.costTotal > 0) return { cost: row.costTotal };
  const provider = providerOf(row), base = provider.replace(/-account-\d+$/, '');
  const rate = prices.find(p => p.provider === provider && row.model.startsWith(p.modelPrefix)) ?? prices.find(p => p.provider === base && row.model.startsWith(p.modelPrefix));
  if (!rate || !tokenKeys.some(k => row[k] > 0)) return {};
  return { cost: tokenKeys.reduce((sum, k) => sum + row[k] * rate[k], 0) / 1e6, reference: rate.reference };
}
function add(total: Total, row: Row, cost: number | undefined, fraction = 1) {
  if (cost === undefined) total.unknown += fraction;
  else total.known += cost * fraction;
  total.tokens += (row.totalTokens || tokenKeys.reduce((n, k) => n + row[k], 0)) * fraction;
  total.calls += fraction;
}

function stats(deliveries: { cost: number | null }[]) {
  const values = deliveries.flatMap(d => d.cost === null ? [] : [d.cost]).sort((a, b) => a - b);
  const quantile = (p: number) => {
    if (!values.length) return null;
    const i = (values.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return values[lo] + (values[hi] - values[lo]) * (i - lo);
  };
  return { count: values.length, omitted: deliveries.length - values.length, median: quantile(.5), p25: quantile(.25), p75: quantile(.75) };
}

type ReportOptions = { now?: number; week?: string; completed?: boolean; sessions?: string; config?: string; merges?: string };

export async function costReport(dir: string, options: ReportOptions = {}, config = loadConfig(dir, options.config)) {
  const now = options.now ?? Date.now(), { from, to } = period(options.week, now, !!options.completed);
  const prevFrom = offsetDay(from, -7), ledgerWarnings: string[] = [];
  const scope = config.githubScope ?? 'author:@me';
  const [merges, evidence] = await Promise.all([
    options.merges ? mergesFromFile(options.merges) : githubMerges([prevFrom, from, to], scope),
    sessionEvidence(options.sessions ?? config.sessionsDir ?? join(agentDir(), 'sessions'), prevFrom, to, config.deployRepo),
  ]);
  const { prs, turns, deploys, agy } = evidence;
  if (evidence.invalid) ledgerWarnings.push(`${evidence.invalid} entradas inválidas nas sessões.`);
  if (evidence.unknownDeployRepo) ledgerWarnings.push('Há deploys com repositório não configurado (deployRepo).');
  const rows = readCostLedger(dir, prevFrom, to, ledgerWarnings);
  const runs = await runBranches(dir, new Set(rows.flatMap(r => r.runId ? [r.runId] : [])));
  if (runs.invalid) ledgerWarnings.push(`${runs.invalid} metadados de runs ausentes ou inválidos no histórico.`);
  const merged = [...new Map(merges.filter(pr => pr.at >= prevFrom && pr.at < to).map(pr => [pr.url, pr])).values()];
  const workerTargets = new Map<string, Set<string>>();
  const byBranch = new Map<string, typeof merged>();
  for (const pr of merged) {
    const key = repoBranch(pr.repo, pr.branch);
    byBranch.set(key, [...byBranch.get(key) ?? [], pr]);
  }
  const runsByBranch = new Map<string, typeof runs.runs>();
  for (const run of runs.runs) {
    const key = repoBranch(run.repo, run.branch);
    runsByBranch.set(key, [...runsByBranch.get(key) ?? [], run]);
  }
  const deliveries: Delivery[] = [...deploys.values()];
  for (const pr of merged) {
    const actions = (prs.get(pr.url) ?? []).filter(e => e.at <= pr.at + 300_000).sort((a, b) => Number(!!b.direct) - Number(!!a.direct) || a.at - b.at);
    const key = repoBranch(pr.repo, pr.branch);
    deliveries.push({ kind: 'pr', id: pr.url, repo: pr.repo, at: pr.at, title: pr.title, turn: actions.find(a => a.turn)?.turn, agy: !!pr.branch && agy.has(key) });
    const linkedRuns = new Set(actions.flatMap(a => a.run ? [a.run] : []));
    for (const run of (pr.branch ? runsByBranch.get(key) : undefined) ?? []) {
      if (run.started <= pr.at && byBranch.get(key)!.filter(p => p.at >= run.started).length === 1) linkedRuns.add(run.id);
    }
    for (const id of linkedRuns) {
      const candidates = workerTargets.get(id) ?? new Set();
      candidates.add(pr.url); workerTargets.set(id, candidates);
    }
  }
  const turnTargets = new Map<string, string[]>();
  for (const d of deliveries) if (d.turn) turnTargets.set(d.turn, [...turnTargets.get(d.turn) ?? [], d.id]);
  const byProvider = new Map<string, Total>();
  const byRepo = new Map<string, Total>();
  const overhead = new Map(['sem entrega', 'compactor', 'sem vínculo', 'crew (memória)', 'outros'].map(k => [k, zero()]));
  const costs = new Map(deliveries.map(d => [d.id, { ...zero(), prices: new Set<string>(), models: new Map<string, Total>(), runs: new Set<string>() }]));
  for (const row of rows) {
    const turn = row.role === 'main' ? turns.get(`${row.session}:` + row.id) : undefined;
    const worker = row.runId && workerTargets.get(row.runId);
    const dest = turn ? turnTargets.get(turn) : worker && worker.size === 1 ? [...worker] : undefined;
    const { cost, reference } = rateCost(row, config.prices);
    if (row.ts >= from) add(keyTotal(byProvider, providerOf(row)), row, cost);
    if (dest?.length) {
      for (const id of dest) {
        const data = costs.get(id)!;
        add(data, row, cost, 1 / dest.length);
        add(keyTotal(data.models, row.model), row, cost, 1 / dest.length);
        if (reference) data.prices.add(reference);
        if (row.runId) data.runs.add(row.runId);
      }
    } else if (row.ts >= from) {
      const bucket = row.role === 'main' ? turn ? 'sem entrega' : 'sem vínculo' : row.role === 'subagent' || row.runId ? 'sem vínculo' : row.role === 'crew' ? 'crew (memória)' : row.role === 'compactor' ? 'compactor' : 'outros';
      add(overhead.get(bucket)!, row, cost);
    }
  }
  const priced = deliveries.map(({ turn, agy, ...d }) => {
    const { known, unknown, calls, tokens, prices, models, runs: workers } = costs.get(d.id)!;
    const reasons = [...prices];
    if (agy) reasons.push(agyReason);
    if (!calls) reasons.push('nenhum registro de uso ligado à entrega');
    if (unknown) reasons.push('há chamadas sem contagem ou preço');
    const missing = !!agy || !calls || !!unknown;
    const source = missing ? 'sem estimativa' : prices.size ? 'estimado (preço de tabela)' : 'medido';
    if (d.at >= from) {
      const repo = keyTotal(byRepo, d.repo);
      repo.known += known; repo.tokens += tokens; repo.calls += calls; repo.unknown += Number(missing);
    }
    return { ...d, agy: !!agy, cost: missing ? null : known, known: calls > unknown ? known : null, source, reasons, calls, tokens, turns: Number(!!turn), workers: workers.size,
      models: [...models].sort((a, b) => b[1].known - a[1].known || b[1].tokens - a[1].tokens).map(([model]) => model) };
  }).sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const week = priced.filter(d => d.at >= from), previous = stats(priced.filter(d => d.at < from)), current = stats(week);
  const rolling = Array.from({ length: 7 }, (_, day) => {
    const start = offsetDay(from, day), end = Math.min(to, offsetDay(start, 1));
    return { day: dateKey(start), ...(end > start ? stats(priced.filter(d => d.at >= offsetDay(start, -6) && d.at < end)) : { count: 0, omitted: 0, median: null, p25: null, p75: null }) };
  });
  return { from: dateKey(from), through: new Date(to).toISOString(), scope, warnings: ledgerWarnings, deliveries: week, stats: current, previous,
    changePercent: current.median !== null && previous.median !== null && previous.median > 0 ? 100 * (current.median / previous.median - 1) : null,
    agyUnpriced: week.filter(d => d.agy).length,
    top: week.filter(d => d.cost !== null).sort((a, b) => b.known! - a.known!).slice(0, 5),
    rolling, byProvider: Object.fromEntries(byProvider), byRepo: Object.fromEntries(byRepo), overhead: Object.fromEntries(overhead) };
}

type Report = Awaited<ReturnType<typeof costReport>>;
const money = (usd: number | null) => usd === null ? 'sem estimativa' : `US$ ${usd.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const count = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
const bucketLine = (value: Total, group = 'chamadas') => {
  const known = value.calls > value.unknown || value.known > 0 ? money(value.known) : 'sem estimativa';
  return value.calls || value.unknown ? `${known}${value.unknown ? ` (parcial: ${count(value.unknown)} ${group} sem estimativa)` : ''}` : 'sem registros';
};
export function costHeadline(r: Report) {
  const { median, p25, p75, omitted, count: sample } = r.stats;
  const change = r.changePercent === null ? 'variação indisponível' : `${r.changePercent >= 0 ? '+' : ''}${count(r.changePercent)}%`;
  return `Custo de API por entrega: mediana ${money(median)}${sample ? ` (p25–p75: ${money(p25)}–${money(p75)})` : ''}; semana anterior ${money(r.previous.median)} (${change}; ${r.previous.count} estimadas, ${r.previous.omitted} fora). ${omitted} de ${r.deliveries.length} entregas sem estimativa, fora das estatísticas.`;
}

export async function weeklyCostLine(dir: string, now: number) {
  const config = loadConfig(dir);
  if (!config.weekly) return undefined;
  const report = await costReport(dir, { now, completed: true }, config);
  return `${costHeadline(report)} Sobrecarga: sem entrega ${bucketLine(report.overhead['sem entrega'])}; compactor ${bucketLine(report.overhead.compactor)}; sem vínculo ${bucketLine(report.overhead['sem vínculo'])}. Detalhes: scripts/cost-report.mjs --week ${report.from}${report.warnings.length ? ' (fontes incompletas)' : ''}.`;
}
export function formatCostReport(r: Report) {
  const lines = [`Custo de API por entrega · desde ${r.from} até ${r.through}`, `PRs: ${r.scope}. Custos do ledger e equivalentes de API; não é fatura.`, costHeadline(r), '', 'Entregas:'];
  for (const d of r.deliveries) {
    const label = d.kind === 'pr' ? `PR #${d.id.split('/').at(-1)}` : 'deploy';
    const value = d.cost === null ? `sem estimativa${d.known !== null ? ` (parcela conhecida: ${money(d.known)})` : ''}` : `${money(d.cost)} · ${d.source}`;
    lines.push(`- ${dateKey(d.at)} · ${d.repo} · ${label} · ${d.title} · ${value}${d.reasons.length ? ` — ${d.reasons.join('; ')}` : ''}`);
  }
  if (!r.deliveries.length) lines.push('- Nenhuma entrega confirmada.');
  lines.push('', 'Totais por conta/provedor (uso no período):');
  for (const [key, v] of Object.entries(r.byProvider).sort(([, a], [, b]) => b.known - a.known)) lines.push(`- ${key}: ${bucketLine(v)}`);
  lines.push(`- agy (Gemini): sem estimativa (${r.agyUnpriced} entregas identificadas; agy não está no ledger)`);
  lines.push('', 'Totais por repositório (custo atribuído às entregas, inclusive trabalho anterior):');
  for (const [key, v] of Object.entries(r.byRepo).sort(([, a], [, b]) => b.known - a.known)) {
    lines.push(`- ${key}: ${v.known > 0 ? money(v.known) : 'sem estimativa'}${v.unknown ? ` (${v.unknown} entregas sem estimativa)` : ''}`);
  }
  lines.push('', 'Sobrecarga (uso no período):');
  for (const [key, v] of Object.entries(r.overhead)) lines.push(`- ${key}: ${bucketLine(v)}`);
  lines.push('', 'Top 5 (entregas com estimativa):');
  for (const d of r.top) lines.push(`- ${d.repo} · ${d.kind === 'pr' ? `PR #${d.id.split('/').at(-1)}` : 'deploy'}: ${money(d.cost)} — ${d.turns} turno principal, ${d.workers} workers, ${count(d.calls)} chamadas, ${count(d.tokens)} tokens; ${d.models.slice(0, 3).join(', ')}`);
  lines.push('', 'Mediana móvel de 7 dias [p25–p75]:');
  for (const d of r.rolling) lines.push(`- ${d.day}: ${money(d.median)} [${money(d.p25)}–${money(d.p75)}] · ${d.count} com estimativa, ${d.omitted} fora`);
  if (r.warnings.length) lines.push('', 'Cobertura:', ...r.warnings.map(w => `- ${w}`));
  return lines.join('\n');
}
