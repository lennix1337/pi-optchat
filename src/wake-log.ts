import { commandWords, segments } from './effect-classifier.ts';

/**
 * The #wakes channel: one post per heartbeat wake, idle ones included, so the operator can follow what the agent did on
 * its own. The list of effects comes from the run's tool calls and their results, not from the model's report: edits,
 * commits, pushes, PRs, merges, comments and Slack posts, each with its repo and whether the call failed.
 */

/** The Slack channel name (in the service's `slack.channels`) that receives the wake log. */
export const WAKE_LOG_CHANNEL = 'wakes';

interface Message { role: string; content?: unknown; toolCallId?: string; isError?: boolean }
interface Block { type?: string; text?: string; id?: string; name?: string; arguments?: unknown }

const blocks = (content: unknown): Block[] => Array.isArray(content) ? content.filter((b): b is Block => !!b && typeof b === 'object') : [];
const textOf = (content: unknown) => typeof content === 'string' ? content : blocks(content).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
export const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
const base = (path: string) => path.split(/[\\/]/).pop() ?? path;
const repoIn = (text: string) => /projetos[\\/]+([\w.-]+)/i.exec(text)?.[1];

/** What one executable segment attempted, with ship.mjs and git receipts when present. */
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

/** Each effect of a run, in order, as `repo: what` (failed calls say so); repeated lines are kept once. */
export function wakeEffects(messages: readonly Message[]): string[] {
  const results = new Map<string, { text: string; error: boolean }>();
  for (const m of messages) if (m.role === 'toolResult' && m.toolCallId) results.set(m.toolCallId, { text: textOf(m.content), error: !!m.isError });
  const lines: string[] = [], edited = new Map<string, Set<string>>();
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
        else (edited.get(repo) ?? edited.set(repo, new Set()).get(repo)!).add(base(args.path));
      } else if ((call.name === 'bash' || call.name === 'powershell') && typeof args.command === 'string') {
        const repo = repoIn(args.command);
        for (const segment of segments(args.command, ''))
          lines.push(...shellEffects(segment.command, result?.text ?? '').map(effect => `${repo ? `${repo}: ` : ''}${effect}${failed}`));
      } else if (call.name === 'slack_send') lines.push(`Slack: mensagem para ${typeof args.channel === 'string' ? `#${args.channel}` : 'o canal do trabalho'}${failed}`);
      else if (call.name === 'commitments' && args.action === 'add') lines.push(`compromisso aberto: ${clip(String(args.text ?? ''), 80)}${failed}`);
      else if (call.name === 'commitments' && args.action === 'update' && args.status === 'done') lines.push(`compromisso ${String(args.id ?? '')} fechado${failed}`);
      else if (call.name === 'self_reload') lines.push(`pediu reload do Pi${failed}`);
    }
  }
  const files = [...edited].map(([repo, names]) => `${repo}: editou ${[...names].join(', ')}`);
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
