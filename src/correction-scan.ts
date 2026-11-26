import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ABANDONED_CAUSE, CLAIM_CHECK_PREFIX, FREE_ACTION, UNCHECKED_ADMISSION, UTC_CLOCK, withoutQuotes } from './claim-check.ts';
import { usesRipwire, writesSource } from './ripwire-first-guard.ts';
import { claimsCause } from './cause-claim-guard.ts';
import { weakensTest } from './weaken-test-guard.ts';
import { writesRealPhone } from './package-pii-guard.ts';
import { runsSuite } from './suite-once-guard.ts';
import { memoryShapedReply, nothingNewReply, reasksPending } from './wake-noise.ts';

/** `guardedAt` (ISO) is when a live guard started refusing or retrying the behaviour: hits after it got past the guard. */
export type Rule = { id: string; guardedAt?: string; quote: string; date: string; scope: string; detector: string; precision: string };
export type ScanResult = { id: string; count: number; afterGuard?: number; caught?: number; detected?: number; examples: { file: string; line: number }[] };
export const rules = JSON.parse(readFileSync(new URL('./correction-rules.json', import.meta.url), 'utf8')) as Rule[];
/** The sessions root: the PC keeps one project folder in it, the VM several, so the scan reads every subdirectory. */
export const sessionsDir = () => join(homedir(), '.pi', 'agent', 'sessions');


function sessionFiles(dir: string, since: number): { label: string; full: string }[] {
  if (statSync(dir).isFile()) return [{ label: basename(dir), full: dir }];
  const out: { label: string; full: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readdirSync(path).filter(f => f.endsWith('.jsonl')).map(f => ({ label: join(entry.name, f), full: join(path, f) })));
    else if (entry.name.endsWith('.jsonl')) out.push({ label: entry.name, full: path });
  }
  return out.filter(f => statSync(f.full).mtimeMs >= since);
}

type Content = { type?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Event = { type?: string; customType?: string; content?: unknown; timestamp?: string; message?: { role?: string; stopReason?: string; toolCallId?: string; content?: Content[] | string } };
type Pacing = { active: boolean; directWork: number; wake?: boolean; wakeEdits?: number; checked?: boolean; verified?: boolean; suites?: number; ripwired?: boolean; sent?: string[]; shipped?: number; clicked?: boolean; more?: boolean };

const noPacing = (): Pacing => ({ active: false, directWork: 0 });

function toolCalls(event: Event): Content[] {
  if (event.type !== 'message' || event.message?.role !== 'assistant' || !Array.isArray(event.message.content)) return [];
  return event.message.content.filter(c => c.type === 'toolCall').flatMap(c => {
    if (c.name !== 'multi_tool_use.parallel' || !Array.isArray(c.arguments?.tool_uses)) return [c];
    return c.arguments.tool_uses.filter(t => typeof t?.recipient_name === 'string').map(t => ({ name: t.recipient_name.replace(/^functions\./u, ''), arguments: t.parameters }));
  });
}

type Message = NonNullable<Event['message']>;
const plainText = (msg: Message): string => (typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content : []).filter(c => c.type === 'text').map(c => c.text ?? '').join('\n')).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const ASKS_MORE = /\be ate mesmo mais\b|\bqueremos mais\b|\bcade o mais\b/u;
const LISTED_COUNT = /\b(?:\d+|(?:dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez))\s+(?:itens|items|ideias|pontos|tarefas|passos)\b/u;
const NAMES_EXTRA = /\balem\b|\bextras?\b|\ba mais\b|\badicion(?:ais|al)\b|\+\s?\d|\be mais\s+(?:um|uma|dois|duas|tres|quatro|cinco|\d+)\b|\bmais\s+(?:um|uma|dois|duas|tres|quatro|cinco|\d+)\s+(?:itens?|items?|melhorias?|ideias?|pontos?|tarefas?|passos?)\b/u;
const reportsOnlyListedCount = (text: string): boolean => { const plain = withoutQuotes(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase(); return LISTED_COUNT.test(plain) && !NAMES_EXTRA.test(plain); };

function nextPacing(previous: Pacing, event: Event): Pacing {
  const msg = event.message;
  let state: Pacing = previous;
  if (event.type === 'custom_message' && event.customType === 'optchat-report') {
    const heartbeat = typeof event.content === 'string' && event.content.startsWith('[OptChat heartbeat]');
    state = { ...state, wake: heartbeat, wakeEdits: heartbeat ? 0 : state.wakeEdits, checked: false, verified: false, suites: heartbeat ? 0 : state.suites, ripwired: heartbeat ? false : state.ripwired, sent: [], shipped: 0, clicked: false };
  } else if (event.type === 'message' && msg?.role === 'user') state = { ...state, more: ASKS_MORE.test(plainText(msg)), wake: false, wakeEdits: undefined, checked: false, verified: false, suites: 0, ripwired: false, sent: [], shipped: 0, clicked: false };
  if (event.type === 'message' && (msg?.role === 'user' || (msg?.role === 'assistant' && msg.stopReason === 'stop'))) {
    const text = plainText(msg);
    if (/^quota pacing (?:ended|off)\b/u.test(text)) state = { ...noPacing(), more: state.more };
    else if (!text.includes('?') && (/^quota pacing active\b/u.test(text) || (
      /\b(?:quota|cota)(?: semanal)?\b[^.\n]{0,80}\b(?:acabando|apertando|gastando mais rapido)\b/u.test(text) &&
      (msg.role === 'assistant' || /^(?:ja falei[^.\n]{0,40}|use|usa|delegue|coloca)\b[^.\n]{0,80}\bworkers?\b/u.test(text))
    ))) state = { active: true, directWork: previous.directWork, more: state.more };
  }
  const calls = toolCalls(event);
  if (calls.some(verifiesLive)) state = { ...state, checked: true };
  if (calls.some(verifiesMerge)) state = { ...state, verified: true };
  if (calls.some(clicksThrough)) state = { ...state, clicked: true };
  const sent = [...(state.sent ?? []), ...calls.filter(isOutbound).map(outboundText)];
  if (sent.length) state = { ...state, sent };
  const shipped = (state.shipped ?? 0) + calls.filter(shipsChange).length;
  if (shipped) state = { ...state, shipped };
  const suites = (state.suites ?? 0) + calls.filter(runsSuite).length;
  if (suites) state = { ...state, suites };
  state = { ...state, ripwired: state.ripwired || calls.some(c => usesRipwire(c) || writesSource(c)) };
  const delegated = calls.some(c => c.name === 'spawn' || c.name === 'tell' || (
    (c.name === 'bash' || c.name === 'shell_start') && String(c.arguments?.command ?? '').split(/[;&|\n]/u).some(command =>
      /^\s*node(?:\.exe)?\s+["']?(?:[^\s"';&|]*[\\/])?agy-(?:worker|pc)\.mjs["']?(?:\s|$)/u.test(command) && !/\s--(?:quota|help|version)\b/u.test(command))
  ));
  if (delegated) return { more: state.more, active: state.active, directWork: 0, wake: state.wake, checked: state.checked, verified: state.verified, suites: state.suites, ripwired: state.ripwired, sent: state.sent, shipped: state.shipped, clicked: state.clicked, wakeEdits: state.wakeEdits === undefined ? undefined : 0 };
  const wakeEdits = state.wakeEdits === undefined ? undefined : state.wakeEdits + calls.filter(writesSource).length;
  return { more: state.more, wake: state.wake, wakeEdits, checked: state.checked, verified: state.verified, suites: state.suites, ripwired: state.ripwired, sent: state.sent, shipped: state.shipped, clicked: state.clicked, active: state.active, directWork: state.active ? state.directWork + calls.filter(c => ['bash', 'shell_start', 'edit', 'write'].includes(c.name ?? '')).length : 0 };
}


const shipsChange = (call: Content): boolean => call.name === 'bash' && (() => {
  const command = withoutQuotedText(String(call.arguments?.command ?? ''));
  return (/\bship\.mjs\b/u.test(command) && !/\s--(?:dry-run|pr)\b/u.test(command)) || /\bgh\s+pr\s+create\b|\bgit\s+push\b/u.test(command);
})();
function retroRecap(calls: Content[], shippedBefore: number): boolean {
  let shipped = shippedBefore;
  for (const call of calls) {
    if (shipsChange(call)) { shipped++; continue; }
    if (!isOutbound(call)) continue;
    const text = String(call.arguments?.text ?? '');
    if (!/\bretro\b/iu.test(text)) continue;
    const cited = new Set(text.match(/#\d+\b/gu) ?? []).size;
    if (cited >= 2 && cited > shipped) return true;
  }
  return false;
}

const PROMISE_ENDING = /^(?:agora\s+|ja\s+)?(?:vou|estou)\s+(?:\w+\s+){0,2}?(?:corrig|investig|resolv|ajust|consert|cri[ao]r?|escrev|rod|verific|ler\b|mexer|implement|fazer|checar|conferir|reproduz|test)/u;
function endsWithPromise(final: string): boolean {
  const last = withoutQuotes(final).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/\n+/u).map(l => l.trim()).filter(Boolean).pop() ?? '';
  const sentence = last.split(/(?<=[.!])\s+/u).pop() ?? '';
  return !sentence.includes('?') && PROMISE_ENDING.test(sentence);
}

const OVERDUE_LEFT = /\bc_[0-9a-f]{6}\b[^\n]{0,80}\b(?:atrasad[oa]|overdue|segue\s+pendente)|\b(?:atrasad[oa]|overdue)\b[^\n]{0,80}\bc_[0-9a-f]{6}\b/iu;
const CLOSED = /\b(?:fechei|fechad[oa]|closed|conclu[íi]d[oa])\b/iu;
const LOOK_YOURSELF = /s[óo]\s+voc[êe]\s+(?:consegue|pode)\s+(?:olhar|ver|conferir)|\babr(?:a|indo)\s+a\s+aba\b|\b(?:d[áa]|pode\s+dar)\s+uma\s+olhada\s+n[ao]\s+(?:tela|home|aba|slack)|\bconfere?\s+n[ao]\s+(?:tela|home|aba)\b/iu;

const isOutbound = (call: Content): boolean => call.name === 'slack_send' || call.name === 'whatsapp_send';
const outboundText = (call: Content): string => String(call.arguments?.text ?? '').replace(/\s+/gu, ' ').trim().toLowerCase();

function verifiesMerge(call: Content): boolean {
  return call.name === 'bash' && /\b(?:gh\s+pr\s+checks|statusCheckRollup|mergeStateStatus|gh\s+run\s+(?:watch|view)|npm\s+(?:run\s+)?verify|dentai-ship|local-verify\.mjs)\b/u.test(String(call.arguments?.command ?? ''));
}

function verifiesLive(call: Content): boolean {
  if (call.name === 'browser_harness') return true;
  return call.name === 'bash' && /\b(?:curl|gh\s+(?:run|pr|api)|git\s+log|dentai-ship|verify-release|release-verif\w*)\b|\/health\b/u.test(String(call.arguments?.command ?? ''));
}

const callText = (call: Content): string => String(call.arguments?.command ?? call.arguments?.code ?? '');
function clicksThrough(call: Content): boolean {
  if (call.name === 'browser_harness') return /\bclick\s*\(/u.test(String(call.arguments?.code ?? ''));
  return (call.name === 'bash' || call.name === 'shell_start') && /\bplaywright\s+test\b|\btest:e2e\b/u.test(callText(call));
}
const DEPLOYS = /\bdentai-ship(?:\.mjs)?\b[^\n]*\s--deploy\b|\bdeploy-(?:web|changed|prod)\.ps1\b|\bwrangler\s+(?:pages\s+)?deploy\b/u;
const deploys = (call: Content): boolean => ['bash', 'shell_start', 'vault_run', 'codemode'].includes(call.name ?? '') && DEPLOYS.test(callText(call));

const SCRATCH_RM = /\brm\s+(?:-\S+\s+)+(?:(?:\/tmp\/|~\/\.cache\/|\$HOME\/\.cache\/)[^\s;&|]*\s*)+(?=[;&|\n]|$)/gu;
function withoutScratchCleanup(command: string): string {
  return command.replace(SCRATCH_RM, '').replace(/\bkill\s+-0\b/gu, '');
}

function sleepsToWait(command: string): boolean {
  if (/\b(?:while|until|for)\b[^\n]*;\s*do\b[^\n]*\bsleep\s+\d/u.test(command)) return true;
  return [...command.matchAll(/(?:^|[;&|\n(]\s*)sleep\s+(\d+(?:\.\d+)?)([smhd]?)/gu)].some(m => Number(m[1]) * ({ m: 60, h: 3600, d: 86400 }[m[2]] ?? 1) >= 15);
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
    case 'free-action': return FREE_ACTION.test(withoutQuotes(final));
    case 'ending-offer': return /se quiser\s*,?\s*(?:é|e) só (?:dizer|avisar|falar)[.!]?\s*$/iu.test(final);
    case 'overdue-in-wake': return !!pacing.wake && OVERDUE_LEFT.test(final) && !CLOSED.test(final);
    case 'wake-silence': return !!pacing.wake && !!final && (memoryShapedReply(final) || reasksPending(final) || nothingNewReply(final));
    case 'memory-format': return /\bid\+n\||\bUNRESOLVED\b|^(?:user|talk):/mu.test(final);
    case 'utc-time': return UTC_CLOCK.test(final);
    case 'promise-no-action': return endsWithPromise(final);
    case 'abandoned-cause': return ABANDONED_CAUSE.test(withoutQuotes(final));
    case 'unchecked-own-work': return UNCHECKED_ADMISSION.test(withoutQuotes(final));
    case 'cause-claim': return calls.some(claimsCause);
    case 'premature-merge': return calls.some(c => {
      const command = String(c.arguments?.command ?? '');
      return c.name === 'bash' && /(?:^|[;&|\n])\s*gh\s+pr\s+merge\b/u.test(command) && !/\s--(?:auto|disable-auto)\b/u.test(command) &&
        !pacing.verified && !verifiesMerge(c);
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
    case 'repeated-reply': {
      const seen = new Set(pacing.sent ?? []);
      const texts = calls.filter(isOutbound).map(outboundText).filter(t => t.length >= 40);
      if (texts.some(t => seen.has(t)) || new Set(texts).size < texts.length) return true;
      return final.length > 0 && seen.has(final.replace(/\s+/gu, ' ').trim().toLowerCase()) && final.length >= 40;
    }
    case 'live-claim': return !pacing.checked && !calls.some(verifiesLive) && calls.some(c =>
      (c.name === 'slack_send' || c.name === 'whatsapp_send') &&
      /^\W*(?:j[áa]\s+(?:est[áa]|est[ãa]o)\s+no\s+ar|no\s+ar\b|(?:est[áa]|est[ãa]o)\s+no\s+ar|ao\s+vivo\b)/iu.test(String(c.arguments?.text ?? '')) &&
      !/\b(?:hip[óo]tese|n[ãa]o\s+verific\w*|n[ãa]o\s+confirm\w*|n[ãa]o\s+testei|unverified)\b/iu.test(String(c.arguments?.text ?? '')));
    case 'retro-recap': return retroRecap(calls, pacing.shipped ?? 0);
    case 'deploy-unclicked': return !pacing.clicked && !calls.some(clicksThrough) && calls.some(deploys);
    case 'pipe-status': return calls.some(c => c.name === 'bash' && /\|\s*(?:tail|head|grep)\b(?:[^;\n|&]|&(?!&))*(?:;|&&)\s*(?:echo|printf)\s+["']?rc=\$\?/u.test(withoutQuotedText(String(c.arguments?.command ?? ''))));
    case 'force-action': return calls.some(c => c.name === 'bash' && /(?:\bgh\s+pr\s+merge\b[^\n]*\s--admin\b|\bgit\s+push\b[^\n]*\s(?:--force(?:-with-lease)?|-f)(?:\s|$))/u.test(String(c.arguments?.command ?? '')));
    case 'destructive-git': return calls.some(c => c.name === 'bash' && /\bgit\s+(?:-C\s+\S+\s+)?(?:reset\b[^\n;|&]*\s--hard\b|clean\b[^\n;|&]*\s-[a-z]*f|branch\b[^\n;|&]*\s-D\b|stash\s+(?:drop|clear)\b|worktree\s+remove\b[^\n;|&]*\s(?:--force|-f)\b)/u.test(String(c.arguments?.command ?? '')));
    case 'his-call': return calls.some(c => c.name === 'bash' && /(?:^|[;&|\n(]\s*|\s)(?:(?:sudo\s+)?(?:kill|pkill|killall|taskkill)\s+-?\S|rm\s+-[a-z]*[rR]|(?:deploy-(?:web|changed|prod)\.ps1|wrangler\s+(?:pages\s+)?deploy)\b|dentai-ship\b[^\n]*--deploy)/u.test(withoutScratchCleanup(withoutQuotedText(String(c.arguments?.command ?? '')))));
    case 'weaken-test': return calls.some(weakensTest);
    case 'sleep-poll': return calls.some(c => c.name === 'bash' && sleepsToWait(withoutQuotedText(String(c.arguments?.command ?? ''))));
    case 'more-means-more': return !!pacing.more && (reportsOnlyListedCount(final) || calls.some(c => isOutbound(c) && reportsOnlyListedCount(String(c.arguments?.text ?? ''))));
    case 'look-yourself': return LOOK_YOURSELF.test(withoutQuotes(final)) || calls.some(c => isOutbound(c) && LOOK_YOURSELF.test(withoutQuotes(String(c.arguments?.text ?? ''))));
    case 'package-pii': return calls.some(writesRealPhone);
    default: throw new Error(`Unknown correction detector: ${rule.detector}`);
  }
}

export function scanCorrections(dir: string, since: number, until: number): ScanResult[] {
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) throw new Error('Invalid scan interval');
  const results: ScanResult[] = rules.map(r => ({ id: r.id, count: 0, detected: 0, ...r.guardedAt ? { afterGuard: 0 } : {}, examples: [] }));
  for (const { label: file, full } of sessionFiles(dir, since)) {
    const lines = readFileSync(full, 'utf8').split('\n');
    let pacing = noPacing();
    const drafts: { result: number; line: number; at: number }[] = [];
    const calls = new Map<string, { result: number; at: number; example?: { file: string; line: number } }[]>();
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let event: Event;
      try { event = JSON.parse(lines[i]) as Event; } catch { continue; }
      const at = Date.parse(event.timestamp ?? '');
      if (!Number.isFinite(at) || at >= until) continue;
      rules.forEach((rule, n) => { if (at >= since && detect(rule, event, pacing)) {
        results[n].count++;
        results[n].detected = (results[n].detected ?? 0) + 1;
        if (rule.guardedAt && at >= Date.parse(rule.guardedAt)) results[n].afterGuard!++;
        if (event.message?.stopReason === 'stop') drafts.push({ result: n, line: i, at });
        const example = results[n].examples.length < 3 ? { file, line: i + 1 } : undefined;
        if (example) results[n].examples.push(example);
        for (const c of toolCalls(event)) if (c.id) calls.set(c.id, [...calls.get(c.id) ?? [], { result: n, at, example }]);
      } });
      if (at >= since && event.type === 'custom_message' && typeof event.content === 'string' && event.content.startsWith(CLAIM_CHECK_PREFIX)) {
        for (const d of drafts) if (i - d.line <= 6 && results[d.result].afterGuard !== undefined && d.at >= Date.parse(rules[d.result].guardedAt!)) {
          results[d.result].afterGuard!--;
          results[d.result].caught = (results[d.result].caught ?? 0) + 1;
        }
        drafts.length = 0;
      }
      const reply = event.message;
      if (reply?.role === 'toolResult' && reply.toolCallId && calls.has(reply.toolCallId) && Array.isArray(reply.content) && reply.content.some(c => c.type === 'text' && /^(?:Not run|Não executado):/u.test(c.text ?? ''))) {
        for (const hit of calls.get(reply.toolCallId)!) {
          results[hit.result].count--;
          if (results[hit.result].afterGuard !== undefined && hit.at >= Date.parse(rules[hit.result].guardedAt!)) {
            results[hit.result].afterGuard!--;
            results[hit.result].caught = (results[hit.result].caught ?? 0) + 1;
          }
          if (hit.example) results[hit.result].examples = results[hit.result].examples.filter(e => e !== hit.example);
        }
        calls.delete(reply.toolCallId);
      }
      pacing = nextPacing(pacing, event);
    }
  }
  return results;
}
