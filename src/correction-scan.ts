import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Rule = { id: string; quote: string; date: string; scope: string; detector: string; precision: string };
export type ScanResult = { id: string; count: number; examples: { file: string; line: number }[] };
export const rules = JSON.parse(readFileSync(new URL('./correction-rules.json', import.meta.url), 'utf8')) as Rule[];
export const sessionsDir = () => join(homedir(), '.pi', 'agent', 'sessions', '--C--Users-swluc--');

type Content = { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> };
type Event = { type?: string; timestamp?: string; message?: { role?: string; stopReason?: string; content?: Content[] } };

export function detect(rule: Rule, input: object): boolean {
  const event = input as Event;
  const msg = event.message;
  if (event.type !== 'message' || msg?.role !== 'assistant' || !Array.isArray(msg.content)) return false;
  const final = msg.stopReason === 'stop' ? msg.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n') : '';
  const calls = msg.content.filter(c => c.type === 'toolCall');
  switch (rule.detector) {
    case 'free-action': return /\b(?:posso|pode|quer que eu|rodo|devo)\b[^?\n]{0,80}\b(?:merge\w*|push\w*|recarreg\w*|reload\w*|reinici\w*|restart\w*|public\w*|publish\w*|pr)\b[^?\n]{0,60}\?/iu.test(final);
    case 'ending-offer': return /se quiser\s*,?\s*(?:é|e) só (?:dizer|avisar|falar)[.!]?\s*$/iu.test(final);
    case 'memory-format': return /\bid\+n\||\bUNRESOLVED\b|^(?:user|talk):/mu.test(final);
    case 'utc-time': return /\b\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/u.test(final);
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
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      let event: Event;
      try { event = JSON.parse(lines[i]) as Event; } catch { continue; } // a live session's last line may be half-written
      const at = Date.parse(event.timestamp ?? '');
      if (!(at >= since && at < until)) continue;
      rules.forEach((rule, n) => { if (detect(rule, event)) { results[n].count++; if (results[n].examples.length < 3) results[n].examples.push({ file, line: i + 1 }); } });
    }
  }
  return results;
}
