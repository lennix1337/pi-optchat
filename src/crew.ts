import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { accountGroup } from './account.ts';
import type { ModelChoice } from './compactor.ts';
import { atomicWrite } from './store.ts';
import { stringEnum } from './string-enum.ts';
import { result } from './tools.ts';

/** What a worker is for, and so which model runs it (see `routeFor`). `plan` is a read-only scout that returns contracts. */
export const WORKER_KINDS = ['code', 'mechanical', 'hard', 'plan'] as const;
export type WorkerKind = typeof WORKER_KINDS[number];
/** The projects with a standing specialist: a charter and a short, capped memory on disk. */
export const SPECIALISTS = ['dentai', 'genexus18mcp', 'harness', 'dotfiles'] as const;
export type Specialist = typeof SPECIALISTS[number];
export type WorkerRoutes = Partial<Record<WorkerKind, ModelChoice[]>>;

/** One entry per provider family; the one for the family the main model is on wins (see `routeFor`). */
export const DEFAULT_ROUTES: Record<WorkerKind, ModelChoice[]> = {
  code: [{ provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'high' }, { provider: 'openai-codex', model: 'gpt-6.1-terra', thinking: 'high' }],
  mechanical: [{ provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'medium' }, { provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'medium' }],
  hard: [{ provider: 'anthropic', model: 'claude-opus-5-5', thinking: 'high' }, { provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'high' }],
  plan: [{ provider: 'anthropic', model: 'claude-opus-5-5', thinking: 'high' }, { provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'high' }],
};
/** A specialist's memory stays small enough to load whole into every worker brief. */
export const MEMORY_BYTES = 6 * 1024;
export const CHARTER_BYTES = 4 * 1024;
/** A memory not reviewed for this long is due for the manager's weekly audit. */
export const AUDIT_DAYS = 7;

/** The worker model for a kind on the account the main model is serving: the route for that provider family, addressed at the live
 * account; with no route for that family, the first route. */
export function routeFor(kind: WorkerKind, main: { provider: string } | undefined, routes: WorkerRoutes = {}): ModelChoice {
  const choices = routes[kind]?.length ? routes[kind]! : DEFAULT_ROUTES[kind];
  if (!main) return choices[0];
  const match = choices.find(choice => choice.provider === main.provider) ?? choices.find(choice => accountGroup(choice.provider) === accountGroup(main.provider));
  return match ? { ...match, provider: accountGroup(match.provider) === accountGroup(main.provider) ? main.provider : match.provider } : choices[0];
}

/** The specialist of a working directory: `C:/projetos/<repo>/...`; undefined outside the operator's projects. */
export function specialistOf(cwd: string): Specialist | undefined {
  const repo = /projetos[\\/]+([\w.-]+)/i.exec(cwd)?.[1];
  if (!repo) return undefined;
  if (/^dotfiles$/i.test(repo)) return 'dotfiles';
  if (/^dentai/i.test(repo)) return 'dentai';
  if (/^genexus18mcp/i.test(repo)) return 'genexus18mcp';
  if (/^(?:pi-|ripwire$)/i.test(repo)) return 'harness';
  return undefined;
}

/** The four parts a worker contract names, each as a heading or a leading `Label:`; Portuguese labels count too. */
const PARTS: [string, RegExp][] = [
  ['goal', /^\s*(?:#+\s*|[-*]\s*)?(?:\*\*)?(?:goal|objective|objetivo)\b/im],
  ['acceptance', /^\s*(?:#+\s*|[-*]\s*)?(?:\*\*)?(?:acceptance|aceite|crit[eé]rio)/im],
  ['evidence', /^\s*(?:#+\s*|[-*]\s*)?(?:\*\*)?(?:evidence|proof|prova|evid[eê]ncia)/im],
  ['authority', /^\s*(?:#+\s*|[-*]\s*)?(?:\*\*)?(?:authority|autoridade|limits?|limite)/im],
];
/** The contract parts a worker task lacks; empty when it names all four. */
export const missingParts = (task: string) => PARTS.filter(([, pattern]) => !pattern.test(task)).map(([name]) => name);
export function checkContract(task: string) {
  const missing = missingParts(task);
  if (missing.length) throw new Error(`A worker task is a contract: add ${missing.map(part => `"${part[0].toUpperCase()}${part.slice(1)}:"`).join(', ')} (lines starting with Goal:, Acceptance:, Evidence:, Authority:). Nothing was started.`);
}

/** Whether a config value is a valid `workerModels`: known kinds, each with a non-empty list of model choices. */
export const validRoutes = (value: unknown, choice: (item: unknown) => boolean) => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.entries(value).every(([kind, list]) => (WORKER_KINDS as readonly string[]).includes(kind) && Array.isArray(list) && list.length > 0 && list.every(choice));

/** Writes a capped file whole; refused over its cap, so whatever loads it never needs cutting. */
function writeCapped(path: string, label: string, cap: number, text: string, fix: string) {
  const size = Buffer.byteLength(text);
  if (size > cap) throw new Error(`${label} is ${size} bytes, over its ${cap}-byte cap: ${fix} and write it again. Nothing was written.`);
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, text.endsWith('\n') ? text : `${text}\n`);
  return size;
}

export class Crew {
  constructor(readonly dir: string) {}
  private file(specialist: Specialist, part: 'charter' | 'memory') { return join(this.dir, specialist, `${part}.md`); }
  /** Replaces missions.md whole; capped like a memory, since every wake reads it. */
  writeMissions(text: string) { return writeCapped(join(this.dir, 'missions.md'), 'missions.md', MEMORY_BYTES, text, 'close accepted missions'); }
  read(specialist: Specialist, part: 'charter' | 'memory') {
    try { return readFileSync(this.file(specialist, part), 'utf8'); } catch { return ''; }
  }
  /** Replaces a charter or memory whole. */
  write(specialist: Specialist, part: 'charter' | 'memory', text: string) {
    return writeCapped(this.file(specialist, part), `${specialist} ${part}`, part === 'memory' ? MEMORY_BYTES : CHARTER_BYTES, text, 'trim stale or duplicated lines');
  }
  /** Days since a specialist's memory was last written, or undefined with no memory yet. */
  age(specialist: Specialist, now = Date.now()) {
    try { return (now - statSync(this.file(specialist, 'memory')).mtimeMs) / 86_400_000; } catch { return undefined; }
  }
  /** Specialists whose memory exists and is due for the weekly audit. */
  auditDue(now = Date.now()) { return SPECIALISTS.filter(s => (this.age(s, now) ?? 0) >= AUDIT_DAYS); }
  /** Open missions that carry work across wakes: `missions.md`, capped like a memory. */
  missions() { try { return readFileSync(join(this.dir, 'missions.md'), 'utf8').trim(); } catch { return ''; } }

  /** What a contract worker starts from instead of the manager's chat: its project's charter and memory, then the contract. */
  brief(kind: WorkerKind, specialist: Specialist | undefined) {
    const charter = specialist ? this.read(specialist, 'charter').trim() : '', memory = specialist ? this.read(specialist, 'memory').trim() : '';
    return [
      `[Worker brief] You are a ${kind} worker of the manager (the main OptChat agent). You get a contract and your project's memory, not the manager's chat: everything you need is below or in the repository. Use zoom(id, 1) only for a chat id the contract cites; ask the manager with tell_parent when a decision is missing, and keep working on what you can. Stay inside the contract's authority.`,
      kind === 'plan' ? 'You are a scout: read and investigate, change nothing. Deliver a plan as contracts the manager can hand to code workers, each with Goal, Acceptance, Evidence and Authority.' : '',
      specialist ? `<project-charter project="${specialist}">\n${charter || '(none yet)'}\n</project-charter>\n<project-memory project="${specialist}">\n${memory || '(empty)'}\n</project-memory>` : '',
      `Report: lead with the outcome; classify each acceptance criterion as verified, not verified or blocked, with the evidence you observed; list commits or branches. ${specialist ? `End with "## Memory proposal": at most 5 lines to add, replace or remove in the ${specialist} memory (rules, decisions, traps, open work), or "none". The manager reviews them; never edit the memory yourself.` : ''}`,
    ].filter(Boolean).join('\n\n');
  }
}

/** Tool calls that execute or edit; a manager that makes many of them in one turn is doing a worker's job. */
const EXECUTION = new Set(['bash', 'powershell', 'edit', 'write', 'shell_start']);
export const NUDGE = (count: number) => `[crew] ${count} execution calls in this turn. You are the manager: hand edits, builds and tests to a worker (spawn with kind "code", or "mechanical" for rote work) with a contract, and review its report.`;
/** Appends one reminder to the result of the Nth execution call of a turn, then every N calls after it. */
export function registerDelegationNudge(pi: ExtensionAPI, after: () => number, enabled: () => boolean) {
  let count = 0;
  pi.on('agent_start', () => { count = 0; });
  pi.on('tool_result', event => {
    if (!enabled() || !EXECUTION.has(event.toolName)) return;
    const limit = after();
    if (limit <= 0 || ++count % limit !== 0) return;
    return { content: [...event.content, { type: 'text' as const, text: `\n${NUDGE(count)}` }] };
  });
}

export const MANAGER_DOC = `# Manager mode
You are the manager of a crew. You talk with the operator, decide, plan, write contracts, review workers' results and report. Workers execute. The operator turned this mode on: it is his standing request to delegate to workers, so spawning one needs no further ask (plain subagents without a kind still do).
- Quick reads (about 5 read-only commands) you do yourself. Edits, builds, tests, long investigations and git work go to workers: call spawn with \`kind\` and a contract.
- Kinds: "code" (Sonnet, code changes), "mechanical" (Haiku, rote edits, renames, data gathering), "hard" (Opus, the hardest design or SDK work), "plan" (Opus scout, read-only, returns contracts).
- A contract has lines starting with Goal:, Acceptance:, Evidence: and Authority: (what the worker may and may not do; my authority map caps it). A worker gets the contract and its project's charter and memory, not this chat: put every fact it needs in the contract.
- Review a report like a code review: check its evidence (diff, test output, CI) before you believe it; send it back with tell when it falls short. Push, PRs and merges stay with you.
- Each report ends with a memory proposal: apply the lines that are true and lasting with the crew tool (action "write"); reject the rest. Audit each project memory weekly.
- Open missions that span wakes live in the crew's missions.md: keep each one with its goal, acceptance and next step until accepted.`;

const CREW_PARAMS = Type.Object({
  action: stringEnum(['list', 'read', 'write'] as const),
  project: Type.Optional(stringEnum(SPECIALISTS)),
  part: Type.Optional(stringEnum(['charter', 'memory', 'missions'] as const)),
  text: Type.Optional(Type.String({ description: 'write: the whole new text; it replaces the old one.' })),
}, { additionalProperties: false });

/** The manager's tool over the crew's disk state: project charters, capped memories and the missions that span wakes. */
export const crewTool = (crew: () => Crew) => ({
  name: 'crew', label: 'Crew memory',
  description: `Read or replace the crew's disk state: each project specialist's charter (${CHARTER_BYTES} B cap) and memory (${MEMORY_BYTES} B cap), and missions.md (open work across wakes). list shows sizes and memory age; read and write take project+part (part "missions" needs no project); write replaces the whole text and is refused over the cap. Apply the lines of a worker's memory proposal you verified; never paste a report whole.`,
  parameters: CREW_PARAMS,
  async execute(_id: string, args: { action: 'list' | 'read' | 'write'; project?: Specialist; part?: 'charter' | 'memory' | 'missions'; text?: string }) {
    const c = crew();
    if (args.action === 'list') {
      const rows = SPECIALISTS.map(s => { const age = c.age(s); return `${s}: charter ${Buffer.byteLength(c.read(s, 'charter'))} B, memory ${Buffer.byteLength(c.read(s, 'memory'))} B${age === undefined ? '' : `, written ${age.toFixed(1)} d ago`}`; });
      const due = c.auditDue();
      return result([...rows, `missions: ${Buffer.byteLength(c.missions())} B`, due.length ? `Audit due: ${due.join(', ')}` : 'No audit due.'].join('\n'));
    }
    const part = args.part ?? 'memory';
    if (part !== 'missions' && !args.project) throw new Error(`${args.action} of a ${part} needs project (one of ${SPECIALISTS.join(', ')}).`);
    if (args.action === 'read') return result((part === 'missions' ? c.missions() : c.read(args.project!, part).trim()) || '(empty)');
    if (args.text === undefined) throw new Error('write needs text: the whole new content.');
    const size = part === 'missions' ? c.writeMissions(args.text) : c.write(args.project!, part, args.text);
    return result(`Wrote ${part === 'missions' ? 'missions.md' : `${args.project} ${part}`}: ${size} B.`);
  },
});

export const crewWakeNote = (missions: string, auditDue: readonly string[]) => [
  'Crew: triage here, on the cheap model. For something to build, spawn a "plan" worker for the contracts, then "code" workers to execute; review their reports before you merge. Work continues across wakes through missions.md.',
  missions ? `Open missions (crew missions.md):\n${missions.slice(0, 2048)}` : '',
  auditDue.length ? `Weekly audit due for the memory of: ${auditDue.join(', ')}. Read each, drop stale or wrong lines, write it back.` : '',
].filter(Boolean).join('\n');
