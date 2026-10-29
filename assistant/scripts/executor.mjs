#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../src/ops/service.ts';
import { ExecutorDesk } from '../src/ops/executor-desk.ts';

const usage = `Usage: node assistant/scripts/executor.mjs <config> <restored|reconcile|reviews|approve|deny> [id]
  restored                         list task revisions a backup restore held (read-only; nothing runs or requeues)
  reconcile <taskId> <revision>    end one held revision as failed without running it; requeue it afterwards for a new one
  reviews                          list isolated-browser preview reviews awaiting you, with the exact text they would open
  approve <reviewId> | deny <reviewId>
Reconcile, approve and deny show the item, then need a fresh typed confirmation in this local terminal. Model text, the panel and the
HTTP API cannot decide anything. Approving lets the service open that exact text once in a network-less, disposable browser.`;
const [, , path, action, ...rest] = process.argv;
if (!path || path === '--help' || !action) { console.log(usage); process.exit(path === '--help' ? 0 : 2); }
let desk;
try {
  const config = loadConfig(path);
  if (['reviews', 'approve', 'deny'].includes(action) && !config.executor?.tools) throw new Error('executor_tools_disabled');
  desk = new ExecutorDesk(config);
  const confirm = async (summary, phrase) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('interactive_terminal_required');
    console.log(JSON.stringify(summary, null, 2));
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await prompt.question(`Type ${phrase} to confirm: `); } finally { prompt.close(); }
    if (answer !== phrase) throw new Error('confirmation_declined');
  };
  let output;
  if (action === 'restored' && rest.length === 0) output = { restored: desk.restored() };
  else if (action === 'reviews' && rest.length === 0) output = { reviews: desk.reviews() };
  else if (action === 'reconcile' && rest.length === 2) {
    const [taskId, text] = rest, revision = Number(text);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('id_and_revision_required');
    const held = desk.restored().find(hold => hold.taskId === taskId && hold.revision === revision);
    if (!held) throw new Error('not_held_by_restore');
    await confirm({ action, held }, `reconcile ${taskId} ${revision}`);
    const task = desk.reconcile(taskId, revision);
    output = { taskId: task.taskId, status: task.status, revision: task.revision };
  } else if ((action === 'approve' || action === 'deny') && rest.length === 1) {
    const review = desk.reviews().find(item => item.reviewId === rest[0]);
    if (!review) throw new Error('review_not_pending');
    await confirm({ action, review }, `${action} ${review.reviewId}`);
    desk.decide(review.reviewId, action);
    output = { reviewId: review.reviewId, decision: action };
  } else throw new Error('usage');
  console.log(JSON.stringify(output));
} catch (error) { console.error(error instanceof Error && error.message === 'usage' ? usage : error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
finally { desk?.close(); }
