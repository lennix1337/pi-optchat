import { dashboard, dashboardMermaid } from './dashboard-model.ts';
import { runningItem, type HomeWork } from './home-items.ts';

export function homeDashboard(work: HomeWork, waiting: string[], state: string, modelName: string | undefined, now: number) {
  const model = dashboard({ now, pi: { state, model: modelName }, workers: work.workers ?? [], prs: work.prs, waiting, deliveries: [] });
  const team = model.workers.slice(0, 30).map(w => runningItem([w.kind, w.model, w.label].filter(Boolean).join(' · '), w.started, now).slice(0, 400));
  const diagramWorkers = model.workers.slice(0, 20).map(worker => ({ ...worker, kind: worker.kind.slice(0, 80), model: worker.model.slice(0, 120), label: worker.label.slice(0, 160), ...(worker.target ? { target: { ...worker.target, repo: worker.target.repo.slice(0, 160) } } : {}) }));
  let mermaid = dashboardMermaid({ ...model, workers: diagramWorkers });
  while (mermaid.length > 9500 && diagramWorkers.length) { diagramWorkers.pop(); mermaid = dashboardMermaid({ ...model, workers: diagramWorkers }); }
  return { team, mermaid };
}
