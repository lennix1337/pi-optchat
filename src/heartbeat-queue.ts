import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The operator's backlog for idle time: a markdown checklist in the profile, `- [ ]` open, `- [x]` done, `- [!]` blocked. */
export const queueFile = (dir: string) => join(dir, 'heartbeat-queue.md');

export interface QueueItem { text: string; state: 'open' | 'done' | 'blocked' }

const HEADER = `# Heartbeat work queue
Items the heartbeat works through while the chat is idle, first open one first.
\`- [ ]\` open, \`- [x]\` done, \`- [!]\` blocked (add why). Edit freely.
`;
const itemLine = /^\s*[-*]\s+\[([ xX!])\]\s+(.*\S)\s*$/;
// An agent told to mark a blocked item may annotate the text instead; either way it is not taken.
const annotatedBlocked = /\bblocked\s*:|\(blocked\b|\[blocked\]/i;

export function parseQueue(markdown: string): QueueItem[] {
  return markdown.split(/\r?\n/).flatMap(line => {
    const match = itemLine.exec(line);
    if (!match) return [];
    const [, mark, text] = match;
    return [{ text, state: mark === '!' ? 'blocked' : mark === ' ' && annotatedBlocked.test(text) ? 'blocked' : mark === ' ' ? 'open' : 'done' } as QueueItem];
  });
}

const readQueue = (dir: string) => existsSync(queueFile(dir)) ? parseQueue(readFileSync(queueFile(dir), 'utf8')) : [];

/** The first open item, or undefined when the queue is absent, empty or all done or blocked. */
export const nextQueueItem = (dir: string) => readQueue(dir).find(item => item.state === 'open')?.text;

export function addQueueItem(dir: string, text: string) {
  const item = text.replace(/\s+/g, ' ').trim();
  if (!item) throw new Error('Usage: /heartbeat add <text>');
  const file = queueFile(dir), existing = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  appendFileSync(file, `${existing === undefined ? HEADER : existing === '' || existing.endsWith('\n') ? '' : '\n'}- [ ] ${item}\n`);
}

export function renderQueue(dir: string) {
  const items = readQueue(dir), shown = items.filter(item => item.state !== 'done'), done = items.length - shown.length;
  if (!shown.length) return `Heartbeat work queue is empty${done ? ` (${done} done)` : ''}: /heartbeat add <text>, or edit ${queueFile(dir)}`;
  const next = shown.find(item => item.state === 'open');
  return [`Heartbeat work queue (${queueFile(dir)}):`, ...shown.map(item => `  ${item.state === 'blocked' ? '[!]' : '[ ]'} ${item.text}`),
    `${done} done${next ? ` · next: ${next.text}` : ' · nothing open to take'}`].join('\n');
}
