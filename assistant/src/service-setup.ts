import { defaultComponents, type Observation, type Probe, type SetupComponent } from './setup.ts';
import type { KeyProtector } from './secrets/protector.ts';
import type { StoredEvent } from './store/db.ts';
import { briefingView } from './briefing/view.ts';

type Configuration = {
  databasePath: string;
  profileId?: string;
  executor?: { provider?: string; model?: string };
  google?: { connections: string[] };
  notifications?: { local: boolean };
};
/** Results the running service already produced; read-only, so checking setup never calls a model or an account. */
export type SetupEvidence = { executor?: () => StoredEvent | null; briefing?: () => Promise<unknown | null> };
const sourceLabel = { ok: 'lido', partial: 'parcial', unavailable: 'indisponível' } as const;

/** Read-only configuration observations; presence never proves model, account or notification delivery, only a recorded result does. */
export function serviceSetup(config: Configuration, protector: KeyProtector, evidence: SetupEvidence = {}): SetupComponent[] {
  const components = defaultComponents({ databasePath: config.databasePath, protector,
    ...(config.executor?.provider && config.executor.model ? { model: `${config.executor.provider}/${config.executor.model}` } : {}) });
  const observed = new Map<string, Probe>();
  if (config.executor && !config.executor.model) observed.set('model', async () => executorResult(evidence.executor?.() ?? null));
  if (config.google) observed.set('google', async () => googleRead(config.google!.connections, config.profileId, evidence.briefing));
  if (config.notifications?.local) observed.set('notifications', async () => ({ kind: 'present', detail: 'Notificações locais autorizadas; entrega e leitura humana não verificadas por esta consulta.' }));
  return components.map(component => ({ ...component, probe: observed.get(component.id) ?? component.probe }));
}

function executorResult(event: StoredEvent | null): Observation {
  const at = event ? Date.parse(event.event.observedAt) : NaN;
  if (!event || !Number.isFinite(at)) return { kind: 'present', detail: 'Executor configurado para as contas disponíveis; modelo e inferência ainda não verificados.' };
  return { kind: 'exercised', detail: `O executor gerou ${event.task.status === 'needs_input' ? 'uma pergunta' : 'um rascunho'} com um modelo real (tarefa ${event.task.taskId.slice(0, 8)}).`,
    evidence: `draft-executor event ${event.event.sequence}`, at };
}

async function googleRead(connections: readonly string[], profileId: string | undefined, latest: SetupEvidence['briefing']): Promise<Observation> {
  const declared: Observation = { kind: 'present', detail: `${connections.length} conexão(ões) declarada(s); nenhum resumo guardado mostra leitura de todas. Configuração não prova acesso.` };
  if (!latest || !profileId) return declared;
  let view;
  try { view = briefingView(await latest(), profileId); } catch { return declared; }
  if (!view) return declared;
  const wanted = connections.flatMap(name => [`${name}:mail`, `${name}:calendar`]);
  const states = wanted.map(id => view.sources.find(source => source.sourceId === id));
  const at = Date.parse(view.createdAt);
  if (!Number.isFinite(at) || states.some(source => !source || source.state === 'unavailable')) return declared;
  return { kind: 'exercised', detail: `Última leitura real: ${states.map(source => `${source!.sourceId} ${sourceLabel[source!.state as keyof typeof sourceLabel]}`).join(', ')}.`,
    evidence: `briefing ${view.briefingId}`, at };
}
