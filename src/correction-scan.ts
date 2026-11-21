import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ABANDONED_CAUSE, UNCHECKED_ADMISSION, withoutQuotes } from './claim-check.ts';
import { memoryShapedReply, nothingNewReply, reasksPending } from './wake-noise.ts';

/** `guardedAt` (ISO) is when a live guard started refusing or retrying the behaviour: hits after it got past the guard. */
export type Rule = { id: string; guardedAt?: string; quote: string; date: string; scope: string; detector: string; precision: string };
export type ScanResult = { id: string; count: number; afterGuard?: number; examples: { file: string; line: number }[] };
export const rules = JSON.parse(readFileSync(new URL('./correction-rules.json', import.meta.url), 'utf8')) as Rule[];
/** The sessions root: the PC keeps one project folder in it, the VM several, so the scan reads every subdirectory. */
export const sessionsDir = () => join(homedir(), '.pi', 'agent', 'sessions');


function sessionFiles(dir: string, since: number): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readdirSync(path).filter(f => f.endsWith('.jsonl')).map(f => join(entry.name, f)));
    else if (entry.name.endsWith('.jsonl')) out.push(entry.name);
  }
  return out.filter(f => statSync(join(dir, f)).mtimeMs >= since);
}

type Content = { type?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Event = { type?: string; customType?: string; content?: unknown; timestamp?: string; message?: { role?: string; stopReason?: string; toolCallId?: string; content?: Content[] | string } };
type Pacing = { active: boolean; directWork: number; wake?: boolean; wakeEdits?: number; checked?: boolean; suites?: number; ripwired?: boolean };

const FULL_SUITE = /(?:^|[;&|\n(])\s*(?:npm\s+(?:run\s+)?(?:test|verify)\b(?![:\w-])|node\b[^;&|\n]*\s--test\b[^;&|\n]*["']test\/\*)/u;
const runsSuite = (call: Content): boolean => (call.name === 'bash' || call.name === 'shell_start') && FULL_SUITE.test(String(call.arguments?.command ?? ''));
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
  if (event.type === 'custom_message' && event.customType === 'optchat-report') {
    const heartbeat = typeof event.content === 'string' && event.content.startsWith('[OptChat heartbeat]');
    state = { ...state, wake: heartbeat, wakeEdits: heartbeat ? 0 : state.wakeEdits, checked: false, suites: heartbeat ? 0 : state.suites, ripwired: false };
  } else if (event.type === 'message' && msg?.role === 'user') state = { ...state, wake: false, wakeEdits: undefined, checked: false, suites: 0, ripwired: false };
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
  if (calls.some(verifiesLive)) state = { ...state, checked: true };
  const suites = (state.suites ?? 0) + calls.filter(runsSuite).length;
  if (suites) state = { ...state, suites };
  state = { ...state, ripwired: state.ripwired || calls.some(c => usesRipwire(c) || writesSource(c)) };
  const delegated = calls.some(c => c.name === 'spawn' || c.name === 'tell' || (
    (c.name === 'bash' || c.name === 'shell_start') && String(c.arguments?.command ?? '').split(/[;&|\n]/u).some(command =>
      /^\s*node(?:\.exe)?\s+["']?(?:[^\s"';&|]*[\\/])?agy-(?:worker|pc)\.mjs["']?(?:\s|$)/u.test(command) && !/\s--(?:quota|help|version)\b/u.test(command))
  ));
  if (delegated) return { active: state.active, directWork: 0, wake: state.wake, checked: state.checked, suites: state.suites, ripwired: state.ripwired, wakeEdits: state.wakeEdits === undefined ? undefined : 0 };
  const wakeEdits = state.wakeEdits === undefined ? undefined : state.wakeEdits + calls.filter(writesSource).length;
  return { wake: state.wake, wakeEdits, checked: state.checked, suites: state.suites, ripwired: state.ripwired, active: state.active, directWork: state.active ? state.directWork + calls.filter(c => ['bash', 'shell_start', 'edit', 'write'].includes(c.name ?? '')).length : 0 };
}


function verifiesLive(call: Content): boolean {
  if (call.name === 'browser_harness') return true;
  return call.name === 'bash' && /\b(?:curl|gh\s+(?:run|pr|api)|git\s+log|dentai-ship|verify-release|release-verif\w*)\b|\/health\b/u.test(String(call.arguments?.command ?? ''));
}


function usesRipwire(call: Content): boolean {
  return call.name === 'ripwire' || (call.name === 'bash' && /(?:^|[;&|\n(]\s*)(?:\S*[\\/])?ripwire(?:\.exe)?\s/u.test(String(call.arguments?.command ?? '')));
}


function writesSource(call: Content): boolean {
  if (call.name === 'edit' || call.name === 'write') return true;
  if (call.name !== 'bash') return false;
  const command = String(call.arguments?.command ?? '');
  return /(?:>>?\s*(?!\/tmp\/)[^\s&|;<>]+\.(?:ts|tsx|js|mjs|json|md|py|cs|ps1|ya?ml)\b|\bsed\s+-i\b|\bgit\s+(?:apply|commit)\b|\bship\.mjs\b[^\n]*\s-m\s|open\([^)]*,\s*['"]w)/u.test(command);
}


function withoutQuotedText(command: string): string {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/gu, '')
    .replace(/"(?:[^"\\]|\\[\s\S])*"|'[^']*'/gu, '""');
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
    case 'abandoned-cause': return ABANDONED_CAUSE.test(withoutQuotes(final));
    case 'unchecked-own-work': return UNCHECKED_ADMISSION.test(withoutQuotes(final));
    case 'cause-claim': return calls.some(c => {
      const command = String(c.arguments?.command ?? '');
      const message = String(c.arguments?.text ?? '');
      if (c.name === 'whatsapp_send' || c.name === 'slack_send') {
        return /\b(?:achei\s+(?:o\s+buraco|a\s+causa)|causa\s+(?:achada|encontrada|raiz)|found\s+the\s+(?:cause|bug))\b/iu.test(message) &&
          !/\b(?:hip[óo]tese|n[ãa]o\s+verificad\w*|unverified|hypothesis)\b/iu.test(message);
      }
      return c.name === 'bash' && /\bgh\s+(?:issue|pr)\s+(?:comment|close)\b/u.test(command) &&
        /\b(?:causa\s+(?:achada|encontrada|raiz)|root\s+cause\s+(?:found|is))\b/iu.test(command) &&
        !/\b(?:hip[óo]tese|n[ãa]o\s+verificad\w*|unverified|hypothesis)\b/iu.test(command);
    });
    case 'premature-merge': return calls.some(c => {
      const command = String(c.arguments?.command ?? '');
      return c.name === 'bash' && /(?:^|[;&|\n])\s*gh\s+pr\s+merge\b/u.test(command) && !/\s--(?:auto|disable-auto)\b/u.test(command) &&
        !/\b(?:gh\s+pr\s+checks|statusCheckRollup|mergeStateStatus|gh\s+run\s+(?:watch|view)|npm\s+(?:run\s+)?verify|dentai-ship)\b/u.test(command);
    });
    case 'self-work-under-pacing': return pacing.directWork < 3 && nextPacing(pacing, event).directWork >= 3;
    case 'self-build-in-wake': return (pacing.wakeEdits ?? 0) < 3 && (nextPacing(pacing, event).wakeEdits ?? 0) >= 3;
    case 'ripwire-first': return !pacing.ripwired && calls.some(writesSource) && !calls.some(usesRipwire);
    case 'suite-repeat': return (pacing.suites ?? 0) >= 1 && calls.some(runsSuite);
    case 'dentai-in-wake': return !!pacing.wake && calls.some(c => {
      const command = withoutQuotedText(String(c.arguments?.command ?? ''));
      return c.name === 'bash' && /dentai-mono|tecnologia-ai\/dentai|dentai-ship|\bDENTA-\d+/u.test(command) &&
        /\bgit\s+(?:push|commit)\b|\bgh\s+(?:pr\s+(?:create|merge|comment|close)|issue\s+(?:comment|close))\b|\bship\.mjs\b|\bdentai-ship\b|\bdeploy\b/u.test(command);
    });
    case 'live-claim': return !pacing.checked && !calls.some(verifiesLive) && calls.some(c =>
      (c.name === 'slack_send' || c.name === 'whatsapp_send') &&
      /^\W*(?:j[áa]\s+(?:est[áa]|est[ãa]o)\s+no\s+ar|no\s+ar\b|(?:est[áa]|est[ãa]o)\s+no\s+ar|ao\s+vivo\b)/iu.test(String(c.arguments?.text ?? '')) &&
      !/\b(?:hip[óo]tese|n[ãa]o\s+verific\w*|n[ãa]o\s+confirm\w*|n[ãa]o\s+testei|unverified)\b/iu.test(String(c.arguments?.text ?? '')));
    case 'pipe-status': return calls.some(c => c.name === 'bash' && /\|\s*(?:tail|head|grep)\b(?:[^;\n|&]|&(?!&))*(?:;|&&)\s*(?:echo|printf)\s+["']?rc=\$\?/u.test(withoutQuotedText(String(c.arguments?.command ?? ''))));
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
  const results = rules.map(r => ({ id: r.id, count: 0, ...r.guardedAt ? { afterGuard: 0 } : {}, examples: [] as { file: string; line: number }[] }));
  for (const file of sessionFiles(dir, since)) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    let pacing = noPacing();
    const calls = new Map<string, { result: number; at: number; example?: { file: string; line: number } }[]>();
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let event: Event;
      try { event = JSON.parse(lines[i]) as Event; } catch { continue; }
      const at = Date.parse(event.timestamp ?? '');
      if (!Number.isFinite(at) || at >= until) continue;
      rules.forEach((rule, n) => { if (at >= since && detect(rule, event, pacing)) {
        results[n].count++;
        if (rule.guardedAt && at >= Date.parse(rule.guardedAt)) results[n].afterGuard!++;
        const example = results[n].examples.length < 3 ? { file, line: i + 1 } : undefined;
        if (example) results[n].examples.push(example);
        for (const c of toolCalls(event)) if (c.id) calls.set(c.id, [...calls.get(c.id) ?? [], { result: n, at, example }]);
      } });
      const reply = event.message;
      if (reply?.role === 'toolResult' && reply.toolCallId && calls.has(reply.toolCallId) && Array.isArray(reply.content) && reply.content.some(c => c.type === 'text' && /^(?:Not run|Não executado):/u.test(c.text ?? ''))) {
        for (const hit of calls.get(reply.toolCallId)!) {
          results[hit.result].count--;
          if (results[hit.result].afterGuard !== undefined && hit.at >= Date.parse(rules[hit.result].guardedAt!)) results[hit.result].afterGuard!--;
          if (hit.example) results[hit.result].examples = results[hit.result].examples.filter(e => e !== hit.example);
        }
        calls.delete(reply.toolCallId);
      }
      pacing = nextPacing(pacing, event);
    }
  }
  return results;
}
