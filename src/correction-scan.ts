import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { memoryShapedReply, nothingNewReply, reasksPending } from './wake-noise.ts';

export type Rule = { id: string; quote: string; date: string; scope: string; detector: string; precision: string };
export type ScanResult = { id: string; count: number; examples: { file: string; line: number }[] };
export const rules = JSON.parse(readFileSync(new URL('./correction-rules.json', import.meta.url), 'utf8')) as Rule[];
export const sessionsDir = () => join(homedir(), '.pi', 'agent', 'sessions', '--C--Users-swluc--');

type Content = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type Event = { type?: string; customType?: string; content?: unknown; timestamp?: string; message?: { role?: string; stopReason?: string; content?: Content[] | string } };
/** `wake`: the run in progress started with an OptChat heartbeat prompt, so its final text is a wake report. */
type Pacing = { active: boolean; directWork: number; wake?: boolean };
const noPacing = (): Pacing => ({ active: false, directWork: 0 });

function toolCalls(event: Event): Content[] {
  if (event.type !== 'message' || event.message?.role !== 'assistant' || !Array.isArray(event.message.content)) return [];
  return event.message.content.filter(c => c.type === 'toolCall').flatMap(c => {
    if (c.name !== 'multi_tool_use.parallel' || !Array.isArray(c.arguments?.tool_uses)) return [c];
    return c.arguments.tool_uses.filter(t => typeof t?.recipient_name === 'string').map(t => ({ name: t.recipient_name.replace(/^functions\./u, ''), arguments: t.parameters }));
  });
}

function nextPacing(previous: Pacing, event: Event): Pacing {
  const msg = event.message;
  let state: Pacing = previous;
  if (event.type === 'custom_message' && event.customType === 'optchat-report') state = { ...state, wake: typeof event.content === 'string' && event.content.startsWith('[OptChat heartbeat]') };
  else if (event.type === 'message' && msg?.role === 'user') state = { ...state, wake: false };
  if (event.type === 'message' && (msg?.role === 'user' || (msg?.role === 'assistant' && msg.stopReason === 'stop'))) {
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = (typeof msg.content === 'string' ? msg.content : content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    if (/^quota pacing (?:ended|off)\b/u.test(text)) state = noPacing();
    else if (!text.includes('?') && (/^quota pacing active\b/u.test(text) || (
      /\b(?:quota|cota)(?: semanal)?\b[^.\n]{0,80}\b(?:acabando|apertando|gastando mais rapido)\b/u.test(text) &&
      (msg.role === 'assistant' || /^(?:ja falei[^.\n]{0,40}|use|usa|delegue|coloca)\b[^.\n]{0,80}\bworkers?\b/u.test(text))
    ))) state = { active: true, directWork: previous.directWork };
  }
  const calls = toolCalls(event);
  const delegated = calls.some(c => c.name === 'spawn' || c.name === 'tell' || (
    (c.name === 'bash' || c.name === 'shell_start') && String(c.arguments?.command ?? '').split(/[;&|\n]/u).some(command =>
      /^\s*node(?:\.exe)?\s+["']?(?:[^\s"';&|]*[\\/])?agy-worker\.mjs["']?(?:\s|$)/u.test(command) && !/\s--(?:quota|help|version)\b/u.test(command))
  ));
  if (delegated) return { active: state.active, directWork: 0, wake: state.wake };
  return { wake: state.wake, active: state.active, directWork: state.active ? state.directWork + calls.filter(c => ['bash', 'shell_start', 'edit', 'write'].includes(c.name ?? '')).length : 0 };
}

export function detect(rule: Rule, input: object, pacing: Pacing = noPacing()): boolean {
  const event = input as Event;
  const msg = event.message;
  if (event.type !== 'message' || msg?.role !== 'assistant' || !Array.isArray(msg.content)) return false;
  const final = msg.stopReason === 'stop' ? msg.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') : '';
  const calls = msg.content.filter(c => c.type === 'toolCall');
  switch (rule.detector) {
    case 'free-action': return /\b(?:posso|pode|quer que eu|rodo|devo)\b[^?\n]{0,80}\b(?:merge\w*|push\w*|recarreg\w*|reload\w*|reinici\w*|restart\w*|public\w*|publish\w*|pr)\b[^?\n]{0,60}\?/iu.test(final);
    case 'ending-offer': return /se quiser\s*,?\s*(?:é|e) só (?:dizer|avisar|falar)[.!]?\s*$/iu.test(final);
    case 'wake-silence': return !!pacing.wake && !!final && (memoryShapedReply(final) || reasksPending(final) || nothingNewReply(final));
    case 'memory-format': return /\bid\+n\||\bUNRESOLVED\b|^(?:user|talk):/mu.test(final);
    case 'utc-time': return /\b\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/u.test(final);
    case 'abandoned-cause': return /\b(?:causas?\s+n[ãa]o\s+(?:(?:foi|foram)\s+)?encontrad[ao]s?|sem\s+causa\s+encontrada|causes?\s+(?:(?:is|were|was|still)\s+)*not\s+found)\b/iu.test(final);
    case 'unchecked-own-work': return /\b(?:(?:ainda\s+)?n[ãa]o\s+(?:confirmei|verifiquei|conferi|chequei|validei)|I\s+(?:did\s+not|didn't|have\s+not|haven't)\s+(?:confirm|verif|check)\w*)\b/iu.test(final);
    case 'cause-claim': return calls.some(c => {
      const command = String(c.arguments?.command ?? '');
      return c.name === 'bash' && /\bgh\s+(?:issue|pr)\s+(?:comment|close)\b/u.test(command) &&
        /\b(?:causa\s+(?:achada|encontrada|raiz)|root\s+cause\s+(?:found|is))\b/iu.test(command) &&
        !/\b(?:hip[óo]tese|n[ãa]o\s+verificad\w*|unverified|hypothesis)\b/iu.test(command);
    });
    case 'premature-merge': return calls.some(c => {
      const command = String(c.arguments?.command ?? '');
      return c.name === 'bash' && /\bgh\s+pr\s+merge\b/u.test(command) && !/\s--auto\b/u.test(command) &&
        !/\b(?:gh\s+pr\s+checks|statusCheckRollup|mergeStateStatus|gh\s+run\s+(?:watch|view)|npm\s+(?:run\s+)?verify|dentai-ship)\b/u.test(command);
    });
    case 'self-work-under-pacing': return pacing.directWork < 3 && nextPacing(pacing, event).directWork >= 3;
    case 'pipe-status': return calls.some(c => c.name === 'bash' && /\|\s*(?:tail|head|grep)\b[^;\n|]*(?:;|&&)\s*(?:echo|printf)\s+["']?rc=\$\?/u.test(String(c.arguments?.command ?? '')));
    case 'force-action': return calls.some(c => c.name === 'bash' && /(?:\bgh\s+pr\s+merge\b[^\n]*\s--admin\b|\bgit\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)(?:\s|$))/u.test(String(c.arguments?.command ?? '')));
    case 'weaken-test': return calls.some(c => {
      if (c.name !== 'edit' || !/(?:^|[\\/])(?:test|tests|__tests__)(?:[\\/])|\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(String(c.arguments?.path ?? ''))) return false;
      const edits = Array.isArray(c.arguments?.edits) ? c.arguments.edits : [c.arguments];
      return edits.some((e: { oldText?: string; newText?: string }) => {
        const old = e.oldText ?? '', next = e.newText ?? '';
        if (/\.skip\b|\bretry\b/iu.test(next) && !/\.skip\b|\bretry\b/iu.test(old)) return true;
        const num = /\b(?:timeout|budget)[\w]*\s*[:=]\s*(\d+)/iu;
        const a = old.match(num), b = next.match(num);
        return !!a && !!b && Number(b[1]) > Number(a[1]);
      });
    });
    default: throw new Error(`Unknown correction detector: ${rule.detector}`);
  }
}

export function scanCorrections(dir: string, since: number, until: number): ScanResult[] {
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) throw new Error('Invalid scan interval');
  const results = rules.map(r => ({ id: r.id, count: 0, examples: [] as { file: string; line: number }[] }));
  for (const file of readdirSync(dir).filter(f => f.endsWith('.jsonl') && statSync(join(dir, f)).mtimeMs >= since)) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    let pacing = noPacing();
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let event: Event;
      try { event = JSON.parse(lines[i]) as Event; } catch { continue; } // a live session's last line may be half-written
      const at = Date.parse(event.timestamp ?? '');
      if (!Number.isFinite(at) || at >= until) continue;
      rules.forEach((rule, n) => { if (at >= since && detect(rule, event, pacing)) { results[n].count++; if (results[n].examples.length < 3) results[n].examples.push({ file, line: i + 1 }); } });
      pacing = nextPacing(pacing, event);
    }
  }
  return results;
}
