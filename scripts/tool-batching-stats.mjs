// Measures how often the model asks for one tool per reply when the next reply
// is also a lone read-only call (a missed batch), and the round-trip it costs.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
// Usage: node tool-batching-stats.mjs [sessionsDir] [sinceISO]; the dir defaults to ~/.pi/agent/sessions.
const root = process.argv[2] ?? join(homedir(), '.pi', 'agent', 'sessions'), sinceMs = Date.parse(process.argv[3] ?? '1970-01-01');
const READS = new Set(['read', 'zoom', 'output_read', 'project_evidence', 'ripwire', 'date']);
const isRead = c => READS.has(c.name) || (c.name === 'bash' && /^\s*(cd [^&;]+(&&|;)\s*)?(grep|rg|sed -n|cat|ls|git (status|log|diff|show)|head|wc)\b/.test(String(c.arguments?.command ?? '')));
const files = []; const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else if (n.endsWith('.jsonl') && s.mtimeMs >= sinceMs) files.push(p); } };
walk(root);
let replies = 0, single = 0, multi = 0, missed = 0, gapMs = [];
for (const f of files) {
  let prev = null, prevEnd = 0;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e.message; if (e.type !== 'message' || !m) continue;
    const t = Date.parse(e.timestamp);
    if (m.role === 'toolResult') { prevEnd = t; continue; }
    if (m.role !== 'assistant' || t < sinceMs) { if (m.role === 'user') prev = null; continue; }
    const calls = (m.content ?? []).filter(c => c.type === 'toolCall');
    if (!calls.length) { prev = null; continue; }
    replies++; calls.length === 1 ? single++ : multi++;
    const lone = calls.length === 1 && isRead(calls[0]);
    if (lone && prev) { missed++; if (prevEnd) gapMs.push(t - prevEnd); }
    prev = lone ? calls[0] : null;
  }
}
gapMs.sort((a, b) => a - b);
const med = gapMs[gapMs.length >> 1] ?? 0, sum = gapMs.reduce((a, b) => a + Math.min(b, 120000), 0);
console.log(JSON.stringify({ files: files.length, replies, single, multi, singleShare: +(single / replies).toFixed(3), missedReadBatches: missed, missedShare: +(missed / replies).toFixed(3), medianRoundTripS: +(med / 1000).toFixed(1), wastedMinutes: +(sum / 60000).toFixed(1) }));
