import { acceptedPr } from './accepted-pr.ts';
import { commandWords, segments } from './effect-classifier.ts';
import { callDelta, deltaText, type LineDelta } from './diff-stat.ts';







/** The Slack channel name (in the service's `slack.channels`) that receives the wake log. */
export const WAKE_LOG_CHANNEL = 'wakes';

interface Message { role: string; content?: unknown; toolCallId?: string; isError?: boolean }
interface Block { type?: string; text?: string; id?: string; name?: string; arguments?: unknown }

const blocks = (content: unknown): Block[] => Array.isArray(content) ? content.filter((b): b is Block => !!b && typeof b === 'object') : [];
const textOf = (content: unknown) => typeof content === 'string' ? content : blocks(content).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
export const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
const base = (path: string) => path.split(/[\\/]/).pop() ?? path;
const repoIn = (text: string) => /projetos[\\/]+([\w.-]+)/i.exec(text)?.[1];


function shellEffects(segment: string, output: string): string[] {
  const words = commandWords(segment), command = words.join(' '), found: string[] = [];
  if (words[0] === 'node' && /(?:^|[/\\])ship\.mjs["']?$/.test(words[1] ?? '')) {
    const status = /^status: (\w+)/m.exec(output)?.[1], commit = /^commit: "?([0-9a-f]{7,40})/m.exec(output)?.[1], pr = /^pr: (\d+)/m.exec(output)?.[1];
    const url = /^url: "?(https:\/\/github\.com\/[^"\s]+\/pull\/\d+)/m.exec(output)?.[1];
    if (/--pr\s+\d+/.test(command) && !commit) found.push(`auto-merge na PR #${/--pr\s+(\d+)/.exec(command)![1]}${status ? ` (${status})` : ''}`);
    else found.push(`ship: ${[commit && `commit ${commit}`, pr && (url ? `<${url}|PR #${pr}>` : `PR #${pr}`)].filter(Boolean).join(', ') || 'sem commit'}${status && status !== 'queued' ? ` (${status})` : status ? ' (auto-merge na fila)' : ''}`);
    return found;
  }
  for (const m of command.matchAll(/^gh\s+pr\s+(merge|close|comment|review)\s+(\d+)([^;&|\n]*)/g)) {
    const repo = /(?:--repo|-R)\s+([\w.-]+\/[\w.-]+)/.exec(m[3]!)?.[1];
    const pr = repo ? `<https://github.com/${repo}/pull/${m[2]}|PR #${m[2]}>` : `PR #${m[2]}`;
    found.push(m[1] === 'merge' ? `${/--auto\b/.test(m[3]!) ? 'auto-merge na fila' : 'merge'} da ${pr}` : m[1] === 'close' ? `fechou a ${pr}` : m[1] === 'review' ? `revisou a ${pr}` : `comentou na ${pr}`);
  }
  const opened = /(https:\/\/github\.com\/\S+\/pull\/(\d+))/.exec(output);
  if (/^gh\s+pr\s+create\b/.test(command)) found.push(`abriu ${opened ? `<${opened[1]}|PR #${opened[2]}>` : 'PR'}`);
  for (const m of command.matchAll(/^gh\s+issue\s+(comment|close|reopen)\s+(\d+)/g))
    found.push(m[1] === 'comment' ? `comentou na issue #${m[2]}` : m[1] === 'close' ? `fechou a issue #${m[2]}` : `reabriu a issue #${m[2]}`);
  if (/^gh\s+issue\s+create\b/.test(command)) found.push(`abriu issue${/\/issues\/(\d+)/.exec(output) ? ` #${/\/issues\/(\d+)/.exec(output)![1]}` : ''}`);
  if (/^gh\s+release\s+create\b/.test(command)) found.push('criou release');
  if (/^npm\s+publish\b/.test(command)) found.push('npm publish');
  const deleted = /^git\s+push\b[^;&|\n]*--delete\s+(\S+)/.exec(command);
  if (deleted) found.push(`apagou a branch remota ${deleted[1]}`);
  else {
    if (/^git\s+(?:-[cC]\s+\S+\s+)*commit\b/.test(command)) {
      for (const m of output.matchAll(/^\[(.+?) ([0-9a-f]{7,40})\]/gm)) found.push(`commit ${m[2]} em ${m[1]!.replace(/ \(root-commit\)$/, '')}`);
      if (!found.length) found.push('commit');
    }
    if (/^git\s+(?:-[cC]\s+\S+\s+)*push\b/.test(command)) found.push(`push${/\[new branch\]\s+(\S+)/.exec(output) ? ` (branch nova ${/\[new branch\]\s+(\S+)/.exec(output)![1]})` : ''}`);
  }
  return found;
}

/** The #wakes thread the wake's council opened (council.mjs prints its ts), so the wake's log lands under its own
 *  council instead of as a separate post; undefined when the wake held no council. */
export function councilThread(messages: readonly Message[]): string | undefined {
  const councils = new Set<string>();
  for (const m of messages) if (m.role === 'assistant') for (const call of blocks(m.content))
    if (call.type === 'toolCall' && call.id && /\bcouncil\.mjs\b/.test(String((call.arguments as { command?: unknown } | undefined)?.command ?? ''))) councils.add(call.id);
  for (const m of messages) if (m.role === 'toolResult' && m.toolCallId && councils.has(m.toolCallId)) {
    const ts = /"channel":"wakes","ts":"(\d+\.\d+)"/.exec(textOf(m.content))?.[1];
    if (ts) return ts;
  }
  return undefined;
}

const MAX_FILES = 6;
/** A file edited again adds its line change to the earlier one; a call whose change is unknown leaves the known part as it was. */
function addEdit(files: Map<string, LineDelta | undefined>, name: string, delta: LineDelta | undefined): void {
  const before = files.get(name);
  files.set(name, delta ? { added: (before?.added ?? 0) + delta.added, removed: (before?.removed ?? 0) + delta.removed } : before);
}

/** The files one repository had edited: `editou a.ts, b.ts` when no line count is known, else the count of files and lines with each file's own. */
function editedLine(files: ReadonlyMap<string, LineDelta | undefined>): string {
  const known = [...files.values()].filter((d): d is LineDelta => !!d);
  const each = (name: string, delta: LineDelta | undefined) => `\`${name}\`${delta ? ` (\`${deltaText(delta)}\`)` : ''}`;
  if (!known.length) return `editou ${[...files.keys()].join(', ')}`;
  const total = deltaText({ added: known.reduce((sum, d) => sum + d.added, 0), removed: known.reduce((sum, d) => sum + d.removed, 0) });
  if (files.size === 1) { const [[name, delta]] = [...files]; return `editou ${each(name!, delta)}`; }
  const shown = [...files].slice(0, MAX_FILES).map(([name, delta]) => each(name, delta));
  return `*editou ${files.size} arquivos* (\`${total}\`) \u2014 ${shown.join(', ')}${files.size > MAX_FILES ? `, e mais ${files.size - MAX_FILES}` : ''}`;
}

/** Each effect of a run, in order, as `repo: what` (failed calls say so); repeated lines are kept once. */
export function wakeEffects(messages: readonly Message[]): string[] {
  const results = new Map<string, { text: string; error: boolean }>();
  for (const m of messages) if (m.role === 'toolResult' && m.toolCallId) results.set(m.toolCallId, { text: textOf(m.content), error: !!m.isError });
  const lines: string[] = [], edited = new Map<string, Map<string, LineDelta | undefined>>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const call of blocks(m.content)) {
      if (call.type !== 'toolCall') continue;
      const args = (call.arguments ?? {}) as Record<string, unknown>, result = call.id ? results.get(call.id) : undefined;
      const failed = !result ? ' (resultado não observado)' : result.error ? ' (falhou)' : '';
      if ((call.name === 'edit' || call.name === 'write') && typeof args.path === 'string') {
        if (result?.error) continue;
        const repo = repoIn(args.path) ?? 'fora dos projetos';
        if (!result) lines.push(`${repo}: edição de ${base(args.path)} não confirmada`);
        else addEdit(edited.get(repo) ?? edited.set(repo, new Map()).get(repo)!, base(args.path), callDelta(call.name, args));
      } else if ((call.name === 'bash' || call.name === 'powershell') && typeof args.command === 'string') {
        const repo = repoIn(args.command);
        for (const segment of segments(args.command, ''))
          lines.push(...shellEffects(segment.command, result?.text ?? '').map(effect => `${repo ? `${repo}: ` : ''}${effect}${failed}`));
      } else if (call.name === 'slack_send') lines.push(`Slack: mensagem para ${typeof args.channel === 'string' ? `#${args.channel}` : 'o canal do trabalho'}${failed}`);
      else if (call.name === 'commitments' && args.action === 'add') lines.push(`compromisso aberto: ${clip(String(args.text ?? ''), 80)}${failed}`);
      else if (call.name === 'commitments' && args.action === 'update' && args.status === 'done') lines.push(`compromisso ${String(args.id ?? '')} fechado${failed}`);
      else if (call.name === 'self_reload') lines.push(`pediu reload do Pi${failed}`);
      else if (call.name === 'crew' && args.action === 'accept') {

        const pr = result && !result.error ? acceptedPr(result.text) : undefined;
        if (pr) lines.push(`${pr.repo}: abriu <${pr.url}|PR #${pr.number}> (crew accept)`);
      }
    }
  }
  const files = [...edited].map(([repo, names]) => `${repo}: ${editedLine(names)}`);
  return [...new Set([...files, ...lines])];
}

const clock = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** The #wakes post of one wake: when and how long, the effects found in its calls, and its own report. */
export function wakeLogPost(run: { start: number; end: number; steps: number; messages: readonly Message[]; report: string }): string {
  const last = run.messages[run.messages.length - 1] as { role?: string; stopReason?: string } | undefined;
  const cut = last?.role === 'assistant' && (last.stopReason === 'error' || last.stopReason === 'aborted');
  const effects = wakeEffects(run.messages), minutes = Math.max(0, Math.round((run.end - run.start) / 60_000));
  const head = `*Wake* ${clock(run.start)}\u2192${clock(run.end)} (${minutes} min, ${run.steps} passo${run.steps === 1 ? '' : 's'})${effects.length ? '' : cut ? ' \u00b7 interrompido pelo provedor, retomado em outro post' : ' \u00b7 sem entrega'}`;
  return [head, ...effects.length ? ['*Efeitos:*', ...effects.map(e => `\u2022 ${e}`)] : [], ...run.report ? [`*Relato:* ${run.report}`] : []].join('\n');
}
