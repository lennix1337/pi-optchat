import { brasiliaDayTime } from './pc-health.ts';
import { accounts } from './quota-health.ts';
import { readJsonOr } from './store.ts';
import { safeIdentifier } from './diagnostic-metadata.ts';

/**
 * Commands the operator sends from a remote channel (Slack today, any other channel later) and that the extension
 * answers itself, without a model turn: they cost nothing and answer even while the agent works. Each command returns
 * plain text with *bold* only, so every channel can show it as it is. Quota is the cached reading pi-multi-account
 * keeps; nothing here polls a provider or switches accounts.
 */
export interface CommandState {
  /** The selected model, `provider/id`; with pi-multi-account the provider is the account. */
  model(): string | undefined;
  /** What the agent is doing now, one line. */
  activity(): string;
  /** pi-multi-account's shared state (`provider-failover-state.json`), or `{}`. */
  failover(): unknown;
  now(): number;
}

export interface RemoteCommand { name: string; aliases: readonly string[]; summary: string; run(state: CommandState): string }

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

function quotaLines(state: CommandState): string[] {
  const now = state.now(), data = record(state.failover());
  const measured = new Map(accounts(data, now).map(a => [a.id, a]));
  const ids = [...new Set([...Object.keys(record(data.usageByProvider)), ...measured.keys()])].filter(id => safeIdentifier(id)).sort();
  if (!ids.length) return ['sem leitura de cota (o pi-multi-account ainda não mediu nenhuma conta)'];
  return ids.map(id => {
    const a = measured.get(id);
    if (!a) return `• ${id}: sem medição (conta sem janela de uso, ex. chave de API)`;
    if (a.blockedUntil) return `• ${id}: *esgotada* até ${brasiliaDayTime(a.blockedUntil)}`;
    return `• ${id}: ${a.used}% usado, renova ${brasiliaDayTime(a.resetAt!)}`;
  });
}

function lastSwitch(state: CommandState): string | undefined {
  const list = record(state.failover()).lastSwitches;
  const last = Array.isArray(list) ? record(list[0]) : {};
  if (typeof last.to !== 'string' || typeof last.at !== 'number') return undefined;
  return `última troca: ${last.to} (${brasiliaDayTime(last.at)})`;
}

const modelLine = (state: CommandState) => `*Modelo:* ${state.model() ?? 'nenhum selecionado'}`;

export const REMOTE_COMMANDS: readonly RemoteCommand[] = [
  {
    name: 'status', aliases: ['estado'], summary: 'o que estou fazendo, modelo e conta atuais',
    run: state => [state.activity(), modelLine(state), ...(lastSwitch(state) ? [lastSwitch(state)!] : [])].join('\n'),
  },
  { name: 'cota', aliases: ['cotas', 'quota'], summary: 'cota de cada conta (leitura em cache)', run: state => ['*Cota* (leitura em cache):', ...quotaLines(state)].join('\n') },
  { name: 'modelo', aliases: ['model'], summary: 'modelo e conta em uso', run: state => [modelLine(state), ...(lastSwitch(state) ? [lastSwitch(state)!] : [])].join('\n') },
  {
    name: 'comandos', aliases: ['ajuda', 'help'], summary: 'esta lista',
    run: () => ['*Comandos* (mande só a palavra):', ...REMOTE_COMMANDS.map(c => `• *${c.name}*: ${c.summary}`)].join('\n'),
  },
];

/**
 * The command a whole message names (`status`, `/cota`, `Jarvis modelo`), or undefined for anything else. A question
 * (`status?`) stays a message to the agent.
 */
export function remoteCommand(text: string): RemoteCommand | undefined {
  const word = /^\s*(?:jarvis[\s,:]+)?[/!]?([a-zçã]+)\s*$/i.exec(text)?.[1]?.toLowerCase();
  return word ? REMOTE_COMMANDS.find(c => c.name === word || c.aliases.includes(word)) : undefined;
}

/** The status block of the App Home: model, account and quota under what the agent is doing. */
export function homeStatus(state: CommandState): string {
  return [modelLine(state), '*Cota* (cache):', ...quotaLines(state), '_Mande *comandos* na DM para ver o que posso responder na hora._'].join('\n');
}

export function failoverReader(file: string): () => unknown { return () => readJsonOr<unknown>(file, {}); }
