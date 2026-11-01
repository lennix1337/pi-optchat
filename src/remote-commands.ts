import { brasiliaDayTime } from './pc-health.ts';
import { accounts } from './quota-health.ts';
import { readJsonOr } from './store.ts';
import { safeIdentifier } from './diagnostic-metadata.ts';

/**
 * Commands the operator sends from a remote channel (Slack today, any other channel later) and that the extension
 * answers itself, without a model turn: they cost nothing and answer even while the agent works. Each command returns
 * plain text with *bold* only, so every channel can show it as it is. Quota is the cached reading pi-multi-account
 * keeps; nothing here polls a provider. A model change selects the model through Pi, as `/model` does, so
 * pi-multi-account sees an ordinary user switch; one that changes the account waits for the operator's approval.
 */
export type ModelRef = { provider: string; id: string };
export interface CommandState {
  /** The selected model, `provider/id`; with pi-multi-account the provider is the account. */
  model(): string | undefined;
  /** What the agent is doing now, one line. */
  activity(): string;
  /** pi-multi-account's shared state (`provider-failover-state.json`), or `{}`. */
  failover(): unknown;
  now(): number;
  /** Models with usable credentials, and selecting one (false when Pi refused it). */
  models(): readonly ModelRef[];
  select(model: ModelRef): Promise<boolean>;
}

/** A command's answer; `confirm` is an effect that runs only after the operator approves it. */
export type CommandResult = { text: string; confirm?: { summary: string; apply: () => Promise<string> } };
export interface RemoteCommand { name: string; aliases: readonly string[]; summary: string; run(state: CommandState, arg: string): CommandResult | Promise<CommandResult> }

const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const refName = (m: ModelRef) => `${m.provider}/${m.id}`;

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
const withSwitch = (state: CommandState, lines: string[]) => [...lines, ...(lastSwitch(state) ? [lastSwitch(state)!] : [])].join('\n');
const MAX_LISTED = 40;

/**
 * The model `query` names: `provider/id` exactly, else an id or a unique part of one, first on the current account,
 * then on any account. Returns the match or why there is none.
 */
export function resolveModel(query: string, models: readonly ModelRef[], current: string | undefined): ModelRef | string {
  const q = query.trim().toLowerCase();
  const exact = models.find(m => refName(m).toLowerCase() === q);
  if (exact) return exact;
  const account = current?.split('/')[0];
  for (const pool of [models.filter(m => m.provider === account), models]) {
    const id = pool.filter(m => m.id.toLowerCase() === q);
    if (id.length === 1) return id[0]!;
    const part = pool.filter(m => m.id.toLowerCase().includes(q));
    if (part.length === 1) return part[0]!;
    if (part.length > 1 && pool !== models) return `"${query}" serve para vários modelos desta conta: ${part.slice(0, 8).map(m => m.id).join(', ')}. Seja mais específico.`;
    if (part.length > 1) return `"${query}" serve para vários modelos: ${part.slice(0, 8).map(refName).join(', ')}. Use conta/modelo.`;
  }
  return `Nenhum modelo disponível com "${query}". Mande *modelos* para ver a lista.`;
}

async function changeModel(state: CommandState, query: string): Promise<CommandResult> {
  const found = resolveModel(query, state.models(), state.model());
  if (typeof found === 'string') return { text: found };
  const name = refName(found), current = state.model();
  if (name === current) return { text: `Já estou em ${name}.` };
  const apply = async () => await state.select(found) ? `Modelo trocado para *${name}*.` : `O Pi recusou ${name} (sem credencial válida?). Continuo em ${state.model() ?? 'nenhum'}.`;
  // The provider is the account: changing it is an account switch, which stays the operator's decision.
  if (current?.split('/')[0] !== found.provider) {
    return { text: `Trocar para *${name}* muda a conta (de ${current?.split('/')[0] ?? 'nenhuma'} para ${found.provider}).`, confirm: { summary: `trocar o modelo para ${name} (troca de conta)`, apply } };
  }
  return { text: await apply() };
}

export const REMOTE_COMMANDS: readonly RemoteCommand[] = [
  { name: 'status', aliases: ['estado'], summary: 'o que estou fazendo, modelo e conta atuais', run: state => ({ text: withSwitch(state, [state.activity(), modelLine(state)]) }) },
  { name: 'cota', aliases: ['cotas', 'quota'], summary: 'cota de cada conta (leitura em cache)', run: state => ({ text: ['*Cota* (leitura em cache):', ...quotaLines(state)].join('\n') }) },
  {
    name: 'modelo', aliases: ['model'], summary: 'modelo em uso; *modelo sonnet* troca (outra conta pede aprovação)',
    run: (state, arg) => arg ? changeModel(state, arg) : { text: withSwitch(state, [modelLine(state)]) },
  },
  {
    name: 'modelos', aliases: ['models'], summary: 'modelos disponíveis por conta',
    run: state => {
      const all = state.models();
      if (!all.length) return { text: 'Nenhum modelo com credencial disponível.' };
      const by = new Map<string, string[]>();
      for (const m of all) by.set(m.provider, [...by.get(m.provider) ?? [], m.id]);
      const lines = [...by].map(([provider, ids]) => `• *${provider}*: ${ids.join(', ')}`);
      return { text: ['*Modelos disponíveis*:', ...lines.slice(0, MAX_LISTED)].join('\n') };
    },
  },
  {
    name: 'comandos', aliases: ['ajuda', 'help'], summary: 'esta lista',
    run: () => ({ text: ['*Comandos* (mande só a palavra):', ...REMOTE_COMMANDS.map(c => `• *${c.name}*: ${c.summary}`)].join('\n') }),
  },
];

/** Commands that take an argument; for the others only the bare word counts. */
const TAKES_ARG = new Set(['modelo']);

/**
 * The command a whole message names (`status`, `/cota`, `Jarvis modelo`, `modelo sonnet`), or undefined for anything
 * else. A question (`status?`) or a sentence stays a message to the agent.
 */
export function remoteCommand(text: string): { command: RemoteCommand; arg: string } | undefined {
  const match = /^\s*(?:jarvis[\s,:]+)?[/!]?([a-zçã]+)(?:\s+([\w./:-]{1,80}))?\s*$/i.exec(text);
  const word = match?.[1]?.toLowerCase(), arg = match?.[2] ?? '';
  const command = word ? REMOTE_COMMANDS.find(c => c.name === word || c.aliases.includes(word)) : undefined;
  if (!command || (arg && !TAKES_ARG.has(command.name))) return undefined;
  return { command, arg };
}

/** The status block of the App Home: model, account and quota under what the agent is doing. */
export function homeStatus(state: CommandState): string {
  return [modelLine(state), '*Cota* (cache):', ...quotaLines(state), '_Mande *comandos* na DM para ver o que posso responder na hora._'].join('\n');
}

export function failoverReader(file: string): () => unknown { return () => readJsonOr<unknown>(file, {}); }
