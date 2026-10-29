import { defaultComponents, type Probe, type SetupComponent } from './setup.ts';
import type { KeyProtector } from './secrets/protector.ts';

type Configuration = {
  databasePath: string;
  executor?: { provider?: string; model?: string };
  google?: { connections: string[] };
  notifications?: { local: boolean };
};
/** Read-only configuration observations; presence never proves model, account or notification delivery. */
export function serviceSetup(config: Configuration, protector: KeyProtector): SetupComponent[] {
  const components = defaultComponents({ databasePath: config.databasePath, protector,
    ...(config.executor?.provider && config.executor.model ? { model: `${config.executor.provider}/${config.executor.model}` } : {}) });
  const observed = new Map<string, Probe>();
  if (config.executor && !config.executor.model) observed.set('model', async () => ({ kind: 'present', detail: 'Executor configurado para as contas disponíveis; modelo e inferência ainda não verificados.' }));
  if (config.google) observed.set('google', async () => ({ kind: 'present', detail: `${config.google!.connections.length} conexão(ões) declarada(s); identidade, revogação e leitura devem ser conferidas na conexão. Configuração não prova acesso.` }));
  if (config.notifications?.local) observed.set('notifications', async () => ({ kind: 'present', detail: 'Notificações locais autorizadas; entrega e leitura humana não verificadas por esta consulta.' }));
  return components.map(component => ({ ...component, probe: observed.get(component.id) ?? component.probe }));
}
