// Measures how much of the operator's waiting in the OptChat main session is execution (commands, edits)
// that a router could hand to a worker. Read-only: it reads Pi session files and prints one JSON object.
//
// An operator run is an optchat.run that holds a user-role message (the operator's words). Its wait is from the
// first such message to the last assistant text of the run (the reply), or to the run end when there is none. Within the run, tool calls are
// READ (inspection), EXEC (commands that change or check something, edit/write) or DELEGATED (already spawn/tell/
// shell_start). The EXEC duration is the time from a call's assistant message to its tool result.
//
// usage: node scripts/delegation-stats.mjs <sessionsDir> [sinceISO]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.argv[2];
const sinceMs = Date.parse(process.argv[3] ?? '1970-01-01');
if (!root) throw new Error('usage: delegation-stats.mjs <sessionsDir> [sinceISO]');
const LONG_MS = 60_000;
const DELEGATED = new Set(['spawn', 'tell', 'shell_start', 'shell_status', 'shell_stop']);
// Commands that only inspect: the same reading the batching measurement uses, plus GitHub/Git views.
const READ_BASH = /^\s*(cd [^&;]+(&&|;)\s*)*(grep|rg|sed -n|cat|ls|head|tail|wc|find|stat|du|date|pwd|echo|type|where|which|git (-C \S+ )?(status|log|diff|show|branch|remote|worktree list|rev-parse|fetch)|gh (pr|issue|run) (view|list|checks|status)|gh auth status|ripwire\b)(\s|$)/;
const isExec = call => call.name === 'bash'
  ? !READ_BASH.test(String(call.arguments?.command ?? ''))
  : call.name === 'edit' || call.name === 'write';
const isDelegated = call => DELEGATED.has(call.name) || call.name.startsWith('subagent');

function* sessionFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { yield* sessionFiles(path); continue; }
    if (name.endsWith('.jsonl') && statSync(path).mtimeMs >= sinceMs) yield path;
  }
}

const stats = {
  files: 0, operatorMessages: 0, withRun: 0, runsWithExec: 0, runsWithLongExec: 0,
  toolCalls: 0, readCalls: 0, execCalls: 0, delegatedCalls: 0,
  replyWaitMs: [], execWaitMs: [], waitWithExecMs: [], waitNoExecMs: [],
};
const pct = (values, p) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * p))] : 0;
const seconds = ms => +(ms / 1000).toFixed(1);

for (const file of sessionFiles(root)) {
  const entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const isOptChatMain = entries.some(e => e.type === 'custom' && e.customType === 'optchat.profile');
  if (!isOptChatMain) continue;
  stats.files++;
  // Runs: start/end markers, with the messages between them.
  const runs = [];
  let open;
  for (const e of entries) {
    if (e.type === 'custom' && e.customType === 'optchat.run') {
      if (e.data?.state === 'start') { open = { start: Date.parse(e.timestamp), messages: [] }; runs.push(open); }
      else if (open) { open.end = Date.parse(e.timestamp); open = undefined; }
    } else if (e.type === 'message' && open) open.messages.push(e);
  }
  // The operator's messages sit inside the run they start (a steer lands in the run already open).
  for (const run of runs) {
    if (run.end === undefined) continue;
    const asked = run.messages.filter(e => e.message?.role === 'user').map(e => Date.parse(e.timestamp)).filter(t => t >= sinceMs);
    if (!asked.length) continue;
    stats.operatorMessages += asked.length; stats.withRun++;
    const at = Math.min(...asked);
    const results = new Map();
    const calls = [];
    for (const e of run.messages) {
      if (e.message?.role === 'toolResult') results.set(e.message.toolCallId, Date.parse(e.timestamp));
      if (e.message?.role === 'assistant') for (const c of e.message.content ?? []) if (c.type === 'toolCall') calls.push({ ...c, at: Date.parse(e.timestamp) });
    }
    const replies = run.messages.filter(e => e.message?.role === 'assistant' && (e.message.content ?? []).some(c => c.type === 'text' && c.text?.trim()) && !(e.message.content ?? []).some(c => c.type === 'toolCall'));
    const replyAt = replies.length ? Date.parse(replies[replies.length - 1].timestamp) : run.end;
    const replyWait = Math.max(0, replyAt - at);
    stats.replyWaitMs.push(replyWait);
    let execMs = 0, execCount = 0, longExec = false;
    for (const call of calls) {
      stats.toolCalls++;
      if (isDelegated(call)) { stats.delegatedCalls++; continue; }
      if (!isExec(call)) { stats.readCalls++; continue; }
      stats.execCalls++; execCount++;
      const done = results.get(call.id);
      const took = done === undefined ? 0 : Math.max(0, done - call.at);
      execMs += took; if (took >= LONG_MS) longExec = true;
    }
    stats.execWaitMs.push(execMs);
    if (execCount) { stats.runsWithExec++; stats.waitWithExecMs.push(replyWait); } else stats.waitNoExecMs.push(replyWait);
    if (longExec) stats.runsWithLongExec++;
  }
}

stats.replyWaitMs.sort((a, b) => a - b); stats.execWaitMs.sort((a, b) => a - b);
stats.waitWithExecMs.sort((a, b) => a - b); stats.waitNoExecMs.sort((a, b) => a - b);
const sum = values => values.reduce((a, b) => a + b, 0);
console.log(JSON.stringify({
  root, sinceMs: sinceMs,
  files: stats.files, operatorMessages: stats.operatorMessages, operatorRuns: stats.withRun,
  toolCalls: stats.toolCalls, readCalls: stats.readCalls, execCalls: stats.execCalls, delegatedCalls: stats.delegatedCalls,
  runsWithExec: stats.runsWithExec, runsWithExecShare: stats.withRun ? +(stats.runsWithExec / stats.withRun).toFixed(3) : 0,
  runsWithLongExec: stats.runsWithLongExec, runsWithLongExecShare: stats.withRun ? +(stats.runsWithLongExec / stats.withRun).toFixed(3) : 0,
  replyWaitS: { median: seconds(pct(stats.replyWaitMs, 0.5)), p90: seconds(pct(stats.replyWaitMs, 0.9)), totalMin: +(sum(stats.replyWaitMs) / 60000).toFixed(1) },
  waitWhenExecS: { runs: stats.waitWithExecMs.length, median: seconds(pct(stats.waitWithExecMs, 0.5)), totalMin: +(sum(stats.waitWithExecMs) / 60000).toFixed(1) },
  waitWhenNoExecS: { runs: stats.waitNoExecMs.length, median: seconds(pct(stats.waitNoExecMs, 0.5)), totalMin: +(sum(stats.waitNoExecMs) / 60000).toFixed(1) },
  execBlockingMin: +(sum(stats.execWaitMs) / 60000).toFixed(1),
  execBlockingS: { median: seconds(pct(stats.execWaitMs.filter(v => v > 0), 0.5)), p90: seconds(pct(stats.execWaitMs.filter(v => v > 0), 0.9)) },
}));
