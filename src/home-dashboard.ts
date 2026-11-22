import { dashboard } from './dashboard-model.ts';
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

export function homeDashboard(work: HomeWork, waiting: string[], state: string, modelName: string | undefined, now: number) {
  const model = dashboard({ now, pi: { state, model: modelName }, workers: work.workers ?? [], prs: work.prs, waiting, deliveries: [] });
  const team = model.workers.slice(0, 30).map(w => {
    const label = [w.kind, w.model, w.label].filter(Boolean).map(part => part.slice(0, 90)).join(' · ');
    const target = w.target ? ` → ${w.target.repo.slice(0, 100)}${w.target.pr === undefined ? '' : `#${w.target.pr}`}` : '';
    return runningItem(label + target, w.started, now);
  });
  return { team };
}
