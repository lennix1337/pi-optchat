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
