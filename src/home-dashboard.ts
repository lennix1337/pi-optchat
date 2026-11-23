import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { dashboard } from './dashboard-model.ts';
import type { HomeProduction } from '../assistant/src/channels/slack-relay.ts';
import { runningItem, type HomeWork } from './home-items.ts';

export function shellTarget(label: string, command: string): { repo: string; pr?: number } | undefined {
  if (!/(?:^|[\s/:])agy(?:$|[\s/:])/i.test(`${label} ${command}`)) return undefined;
  const match = /(?:--repo(?:=|\s+)|\brepo:\s*)["']?([\w.-]+(?:\/[\w.-]+)?)(?:#([1-9]\d*))?/i.exec(`${label} ${command}`)
    ?? /\b([\w.-]+(?:\/[\w.-]+)?)#([1-9]\d*)\b/.exec(label);
  return match ? { repo: match[1]!, ...(match[2] ? { pr: Number(match[2]) } : {}) } : undefined;
}

export function homeShell(job: { id: string; label?: string; command: string; started: number }, now: number) {
  const supplied = job.label?.trim();
  const label = supplied && supplied !== job.command.trim() ? supplied : 'Comando em segundo plano';
  const target = shellTarget(job.label ?? '', job.command);
  return {
    job: runningItem(label, job.started, now),
    worker: { id: job.id, kind: 'shell', model: '', label, started: job.started, ...(target ? { target } : {}) },
  };
}

export function homeGraph(work: HomeWork, state: string): import('../assistant/src/channels/home-graph.ts').HomeGraph {
  const nodes = [{ id: 'session', label: `Sessão · ${state}` }];
  const edges: { from: string; to: string }[] = [];
  const prs = work.prs.slice(0, 30);
  prs.forEach((pr, i) => nodes.push({ id: `pr${i}`, label: `${pr.repo}#${pr.number} · ${pr.title}`.slice(0, 200) }));
  (work.workers ?? []).slice(0, 30).forEach((worker, i) => {
    const workerId = `worker${i}`;
    nodes.push({ id: workerId, label: `${worker.kind} · ${worker.label}`.slice(0, 200) });
    edges.push({ from: 'session', to: workerId });
    const matches = prs.flatMap((p, index) => worker.target && (worker.target.pr === undefined || p.number === worker.target.pr) && (p.repo === worker.target.repo || (!worker.target.repo.includes('/') && p.repo.split('/').pop() === worker.target.repo)) ? [index] : []);
    if (matches.length === 1) edges.push({ from: workerId, to: `pr${matches[0]}` });
  });
  prs.forEach((_, i) => { if (!edges.some(e => e.to === `pr${i}`)) edges.push({ from: 'session', to: `pr${i}` }); });
  return { nodes, edges };
}

function healthTail(dir: string): string {
  const fd = openSync(join(dir, 'prod-health.history.jsonl'), 'r');
  try {
    const size = fstatSync(fd).size, start = Math.max(0, size - 16_384);
    const buffer = Buffer.alloc(size - start);
    const length = readSync(fd, buffer, 0, buffer.length, start);
    const content = buffer.subarray(0, length).toString('utf8');
    if (start === 0) return content;
    const newline = content.indexOf('\n');
    return newline < 0 ? '' : content.slice(newline + 1);
  } finally { closeSync(fd); }
}

export function homeProduction(dir: string, now: number): HomeProduction {
  let content: string;
  try { content = healthTail(dir); }
  catch { return { level: 'unknown', detail: 'sem leitura' }; }
  const rows: { at: number; probe: string; ms: number; ok: boolean }[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row.at !== 'number' || !Number.isFinite(row.at) || typeof row.probe !== 'string' || !row.probe.length || typeof row.ms !== 'number' || !Number.isFinite(row.ms) || typeof row.ok !== 'boolean') continue;
      rows.push(row);
    } catch { continue; }
  }
  if (!rows.length) return { level: 'unknown', detail: 'sem leitura' };
  const latest = Math.max(...rows.map(row => row.at));
  const age = Math.max(0, Math.floor((now - latest) / 60_000));
  if (now - latest > 15 * 60_000 || latest > now + 60_000) return { level: 'unknown', detail: `sem leitura há ${age}min` };
  const round = rows.filter(row => row.at === latest);
  const failed = round.find(row => !row.ok);
  if (failed) return { level: 'red', detail: `${failed.probe.slice(0, 100)} com falha` };
  const times = round.map(row => row.ms).sort((a, b) => a - b), middle = Math.floor(times.length / 2);
  const p50 = times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2;
  return { level: 'green', detail: `${round.length}/${round.length} ok, p50 ${Math.round(p50)} ms` };
}

export function homeDashboard(work: HomeWork, waiting: string[], state: string, modelName: string | undefined, now: number) {
  const model = dashboard({ now, pi: { state, model: modelName }, workers: work.workers ?? [], prs: work.prs, waiting, deliveries: [] });
  const team = model.workers.slice(0, 30).map(w => {
    const label = [w.kind, w.model, w.label].filter(Boolean).map(part => part.slice(0, 90)).join(' · ');
    const target = w.target ? ` → ${w.target.repo.slice(0, 100)}${w.target.pr === undefined ? '' : `#${w.target.pr}`}` : '';
    return runningItem(label + target, w.started, now);
  });
  const ci = work.prsKnown === false ? 'unknown' : !work.prs.length ? 'none' : work.prs.some(pr => pr.checks === 'vermelhos') ? 'red' : work.prs.some(pr => pr.checks === 'pendentes') ? 'pending' : 'green';
  return { team, ci } as const;
}
