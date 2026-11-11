/**
 * The specialist patrol: when a tick finds deadline signals for commitments a specialist owns, a read-only worker of that specialist
 * checks them instead of the manager being woken. It records what it saw on the commitments, escalates only what needs the operator,
 * and an item it did not settle still reaches the manager the next tick as the plain deadline signal (see patrol-divert.ts).
 */
import { existsSync } from 'node:fs';
import { Type } from 'typebox';
import type { SpawnTask } from './agents.ts';
import { projectOf } from './crew.ts';
import type { Patrol, PatrolPlan } from './patrol-divert.ts';
import { isActiveRun, type RunInfo } from './runs.ts';
import { describe, overdueRefusal, readCommitments, updateCommitment, type Commitment } from './commitments.ts';
import { stringEnum } from './string-enum.ts';
import { result } from './tools.ts';

const MAX_ITEMS = 25, CLIP = 400;
const clip = (text: string) => text.length > CLIP ? `${text.slice(0, CLIP - 1)}…` : text;

/** The open items a specialist owns that a patrol may work on: ours, not closed, and not already a question waiting for the operator. */
export const patrolItems = (items: readonly Commitment[], project: string) => items.filter(item => item.project === project && item.owner === 'optchat'
  && item.status !== 'done' && item.status !== 'dropped' && !(item.status === 'waiting_operator' && item.choices?.length));

const linkText = (item: Commitment) => {
  const links = item.links;
  const parts = links ? [...links.prs ?? [], ...(links.runs ?? []).map(run => `run ${run}`), ...links.reload ? ['reload'] : []] : [];
  return parts.length ? ` · linked: ${parts.join(', ')}` : '';
};

/** The contract of one patrol: built from the specialist's open commitments and their links, so the manager writes nothing. */
export function patrolContract(project: string, items: readonly Commitment[], now: number) {
  const mine = patrolItems(items, project), shown = mine.slice(0, MAX_ITEMS);
  return [
    `Goal: patrol the open commitments of the ${project} specialist: find the real state of each one and settle it or move it.`,
    'Acceptance: for each item below, one of these is recorded with the commitments tool: progress or a next step; a new due with a next step; done with evidence; or waiting_operator with choices when only the operator can decide.'
      + ' An item overdue 24 h+ must be closed, narrowed (new due + next) or made a question: a note alone is refused.',
    'Evidence: what you observed (git and gh output, CI logs, files), quoted in each update. Reply with one line per item saying what you did; escalate nothing you can settle yourself.',
    `Authority: read-only. You may read files and run git and gh reads (status, log, diff, show, pr view/list/checks, run view/list), and use the commitments tool, which touches only the ${project} items listed here. You may not write or edit files, commit, push, merge, deploy, spawn or message anyone.`,
    '',
    `Open ${project} commitments (${mine.length}${mine.length > shown.length ? `, first ${shown.length} shown` : ''}):`,
    ...shown.map(item => `- ${clip(describe(item, now))}${linkText(item)}`),
  ].join('\n');
}

const params = Type.Object({
  action: stringEnum(['list', 'update']),
  id: Type.Optional(Type.String()),
  progress: Type.Optional(Type.String({ description: 'what you observed' })),
  next: Type.Optional(Type.String()),
  due: Type.Optional(Type.String()),
  dueInMinutes: Type.Optional(Type.Number()),
  status: Type.Optional(stringEnum(['done', 'waiting_operator'])),
  evidence: Type.Optional(Type.String()),
  choices: Type.Optional(Type.Array(Type.String(), { maxItems: 6 })),
}, { additionalProperties: false });
type Params = { action: 'list' | 'update'; id?: string; progress?: string; next?: string; due?: string; dueInMinutes?: number; status?: 'done' | 'waiting_operator'; evidence?: string; choices?: string[] };

/** The commitments tool of a patrol worker: the items of its own project only, and only these moves: progress, next, a new due, done with evidence, or
 * waiting_operator with choices (the one that reaches the operator, reported through `escalated`). It adds nothing, links nothing and never reassigns. */
export function patrolTool(o: { dir: string; project: string; run: string; escalated: (id: string) => void; now?: () => number }) {
  return {
    name: 'commitments', label: 'Commitments',
    description: `The open commitments of ${o.project}: list them, record what you saw, close one with evidence, or ask the operator with choices.`,
    parameters: params,
    async execute(_id: string, args: Params) {
      const now = (o.now ?? Date.now)(), items = readCommitments(o.dir);
      if (args.action === 'list') {
        const mine = patrolItems(items, o.project);
        return result(mine.length ? mine.map(item => `${describe(item, now)}${linkText(item)}`).join('\n') : `No open ${o.project} commitments.`);
      }
      if (!args.id) throw new Error('update needs id');
      const old = items.find(item => item.id === args.id);
      if (!old) throw new Error(`No commitment ${args.id}`);
      if (old.project !== o.project) throw new Error(`${args.id} is not a ${o.project} commitment: this tool touches only the ${o.project} items.`);
      if (old.owner !== 'optchat') throw new Error(`${args.id} is the operator's, not yours to update.`);
      if (args.status === 'waiting_operator' && !args.choices?.length && !old.choices?.length) throw new Error('waiting_operator needs choices: the options he can tap.');
      const input = { id: old.id, status: args.status, next: args.next, due: args.due, dueInMinutes: args.dueInMinutes, evidence: args.evidence, choices: args.choices,
        progress: args.progress ? `patrol ${o.run}: ${args.progress}` : undefined };
      const refusal = overdueRefusal(old, input, now);
      if (refusal) throw new Error(refusal);
      const item = updateCommitment(o.dir, input, now);
      if (item.status === 'waiting_operator' && item.choices?.length && (old.status !== 'waiting_operator' || !old.choices?.length)) o.escalated(item.id);
      return result(`Updated ${describe(item, now)}`);
    },
  };
}

/** The wake line for an item a patrol asked the operator about. */
export const escalationNote = (item: Pick<Commitment, 'id' | 'text'>, project: string) => `patrol of ${project} escalated ${item.id} to the operator (waiting_operator with choices): ${clip(item.text)}`;

const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'blame', 'describe', 'shortlog', 'cat-file', 'grep', 'name-rev', 'merge-base', 'for-each-ref', 'show-ref', 'reflog', 'diff-tree', 'count-objects']);
const GIT_BRANCH_FLAGS = new Set(['-a', '-r', '-v', '-vv', '--list', '--show-current', '--merged', '--no-merged', '--contains']);
const GH_READS: Record<string, readonly string[]> = { pr: ['view', 'list', 'checks', 'diff', 'status'], run: ['list', 'view'], issue: ['view', 'list', 'status'], repo: ['view'], auth: ['status'], workflow: ['list', 'view'], release: ['list', 'view'] };
const GH_API_WRITES = new Set(['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input']);
const PLAIN = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'sort', 'uniq', 'echo', 'pwd', 'date', 'stat', 'file', 'tree', 'cut', 'tr', 'diff', 'basename', 'dirname', 'realpath', 'cd', 'true']);
const FIND_WRITES = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprintf', '-fls', '-fprint0']);

/** The words of each command of a shell line, or the reason it cannot be read: a redirection or a substitution outside single quotes can write. */
function commandsOf(line: string): string[][] | string {
  const commands: string[][] = [[]];
  let word = '', open = false, quote: '' | "'" | '"' = '';
  const end = () => { if (open) commands.at(-1)!.push(word); word = ''; open = false; };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === "'") { if (ch === "'") quote = ''; else word += ch; continue; }
    if (ch === '`' || ch === '$' && line[i + 1] === '(') return 'command substitution';
    if (quote === '"') { if (ch === '"') quote = ''; else word += ch === '\\' && i + 1 < line.length ? line[++i] : ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; open = true; continue; }
    if (ch === '>' || ch === '<') return 'a redirection';
    if (ch === '\\' && i + 1 < line.length) { word += line[++i]; open = true; continue; }
    if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') { end(); if (commands.at(-1)!.length) commands.push([]); continue; }
    if (/\s/.test(ch)) { end(); continue; }
    word += ch; open = true;
  }
  if (quote) return 'an unclosed quote';
  end();
  return commands.filter(words => words.length);
}

function commandRefusal(words: string[]): string | undefined {
  const [name, ...rest] = words;
  if (PLAIN.has(name)) return undefined;
  if (name === 'find') return rest.find(word => FIND_WRITES.has(word)) ? 'find with an action' : undefined;
  if (name === 'git') {
    const args = [...rest];
    while (args[0]?.startsWith('-')) { const flag = args.shift()!; if (flag === '-C' || flag === '-c') args.shift(); }
    const [sub, ...after] = args;
    if (GIT_READS.has(sub)) return undefined;
    if (sub === 'branch') return after.every((word, i) => GIT_BRANCH_FLAGS.has(word) || ['--contains', '--merged', '--no-merged'].includes(after[i - 1])) ? undefined : 'git branch that is not a listing';
    if (sub === 'remote') return after.every(word => word === '-v') ? undefined : 'git remote that is not a listing';
    if (sub === 'worktree') return after[0] === 'list' ? undefined : 'git worktree that is not a listing';
    return `git ${sub ?? ''}`.trim();
  }
  if (name === 'gh') {
    const [area, verb, ...after] = rest;
    if (area === 'api') return [verb, ...after].some(word => GH_API_WRITES.has(word)) ? 'gh api that writes' : undefined;
    return GH_READS[area]?.includes(verb) ? undefined : `gh ${area ?? ''} ${verb ?? ''}`.trim();
  }
  return name;
}

/** Why a patrol's bash call is refused, or undefined: only reads (files, git and gh reads) are allowed, since the tool allowlist cannot tell a read from a write inside bash. */
export function patrolBashRefusal(command: string): string | undefined {
  const commands = commandsOf(command);
  const why = typeof commands === 'string' ? commands : commands.map(commandRefusal).find(refusal => refusal !== undefined);
  return why === undefined ? undefined : `Not run: a patrol is read-only and ${why} is not a read. Use files, git reads (status, log, diff, show) and gh reads (pr view/list/checks, run view/list); record what you see with the commitments tool.`;
}

/** The patrol the heartbeat uses: a specialist is patrolled when the crew has it; a patrol starts as a read-only worker in the project's repo (found from its latest run), and
 * a start that fails later is an escalation line, so the items it was given are not lost. */
export function createPatrol(o: { plan: PatrolPlan; dir: string; specialists(): readonly string[]; runs(): readonly RunInfo[]; spawn(task: SpawnTask, cwd: string): Promise<unknown>;
  escalate(project: string, line: string): void; now?: () => number }): Patrol {
  return {
    plan: o.plan,
    handles: project => o.specialists().includes(project),
    running: project => o.runs().some(run => run.kind && run.project === project && isActiveRun(run)),
    start(project, findings) {
      const cwd = o.runs().filter(run => run.kind && run.project === project && !run.patrol).sort((a, b) => b.started - a.started).map(run => projectOf(run.cwd)?.path ?? run.cwd).find(path => existsSync(path));
      if (!cwd) return false;
      const task = patrolContract(project, readCommitments(o.dir), (o.now ?? Date.now)());
      o.spawn({ task, cwd, kind: o.plan.kind, project, patrol: true }, cwd).catch(error => o.escalate(project, `patrol of ${project} could not start (${error instanceof Error ? error.message : String(error)}); ${findings.map(finding => finding.line).join('; ')}`));
      return true;
    },
  };
}
