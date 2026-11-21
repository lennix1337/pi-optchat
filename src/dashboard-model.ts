import type { PrItem } from './home-items.ts';

export type DashboardWorker = {
  id: string;
  kind: string;
  model: string;
  label: string;
  started: number;
  target?: { repo: string; pr?: number };
};

export type DashboardInput = {
  now: number;
  pi: { state: string; model?: string };
  workers: readonly DashboardWorker[];
  prs: readonly PrItem[];
  waiting: readonly string[];
  deliveries: readonly string[];
};

export function dashboard(input: DashboardInput) {
  return {
    generatedAt: input.now,
    pi: { ...input.pi },
    workers: input.workers.map(worker => ({ ...worker, ...(worker.target ? { target: { ...worker.target } } : {}), ageMs: Math.max(0, input.now - worker.started) })),
    prs: input.prs.map(pr => ({ ...pr })),
    waiting: [...input.waiting],
    deliveries: [...input.deliveries],
  };
}

export type Dashboard = ReturnType<typeof dashboard>;

function mermaidLabel(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/[#"&<>`]/g, character => `#${character.charCodeAt(0)};`);
}

export function dashboardMermaid(model: Dashboard): string {
  const lines = ['flowchart LR', '  root["OptChat"]'];
  model.workers.forEach((worker, index) => {
    lines.push(`  w${index}["${mermaidLabel([worker.kind, worker.model, worker.label].filter(Boolean).join(' · '))}"]`, `  root --> w${index}`);
    if (worker.target) {
      const target = `${worker.target.repo}${worker.target.pr === undefined ? '' : `#${worker.target.pr}`}`;
      lines.push(`  target${index}["${mermaidLabel(target)}"]`, `  w${index} --> target${index}`);
    }
  });
  return lines.join('\n');
}
