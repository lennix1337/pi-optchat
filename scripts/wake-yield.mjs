#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { wakeYield } from '../src/wake-yield.ts';

const args = process.argv.slice(2);
let start = Date.now() - 24 * 3600000;
if (args.length) {
  if (args.length !== 2 || args[0] !== '--since' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/u.test(args[1]) || !Number.isFinite(Date.parse(args[1]))) {
    throw new Error('Usage: node scripts/wake-yield.mjs [--since ISO]');
  }
  start = Date.parse(args[1]);
}
const end = Date.now();
const dir = join(homedir(), '.pi', 'agent', 'sessions', '--home-ubuntu--');
const files = readdirSync(dir).filter(name => name.endsWith('.jsonl')).map(name => {
  const path = join(dir, name);
  return { path, mtime: statSync(path).mtimeMs };
}).sort ( (a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path));
if (!files.length) throw new Error(`No session files found in ${dir}`);
const { wakes, summary } = wakeYield(readFileSync(files[0].path, 'utf8'), start, end);
const time = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
console.log(`Session: ${files[0].path}\nWindow: ${new Date(start).toISOString()} to ${new Date(end).toISOString()}`);
console.log('Início (Brasília)\tMensagens\tModelos\tEntrega');
for (const wake of wakes) console.log(`${time.format(new Date(wake.start))}\t${wake.messages}\t${wake.models.join(', ') || '-'}\t${wake.delivered ? 'sim' : 'não'}`);
const share = summary.messages ? `${(100 * summary.messagesWithout / summary.messages).toFixed(1)}%` : 'n/a';
console.log(`Resumo: wakes ${summary.wakes}; com entrega ${summary.delivered}; sem entrega ${summary.without}; mensagens em wakes sem entrega ${summary.messagesWithout}/${summary.messages} (${share}).`);
