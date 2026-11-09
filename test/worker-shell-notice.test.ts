import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { ShellJobs, shellReporter } from '../src/shells.ts';
import { Memory } from '../src/memory.ts';
import { emptyUsage } from '../src/usage.ts';
import { textContent, withoutFullChat } from '../src/transcript.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

async function until(condition: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 10)); }
}

/**
 * Workers whose first turn calls shell_start on a command that ends when a marker file appears. "busy-*" and "gone-*" workers then
 * hold their next turn, so they are still running when the shell ends; the others finish at once.
 */
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-worker-shell-'));
  const watcher = join(dir, 'watch.cjs');
  writeFileSync(watcher, "const fs=require('fs');const f=process.argv[2];const t=setInterval(()=>{if(fs.existsSync(f)){console.log('GATE-DONE');clearInterval(t)}},20);");
  const marker = (task: string) => join(dir, task).replace(/\\/g, '/');
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const reports: string[] = [], warnings: string[] = [], mainNotices: string[] = [], releases = new Map<string, () => void>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'child', name: 'Synthetic child', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const task = textContent(context.messages.find(m => m.role === 'user')?.content).split('Your task:\n').at(-1) ?? '';
      const last = context.messages.at(-1), lastText = textContent(last && 'content' in last ? last.content : '');
      const first = context.messages.filter(m => m.role === 'assistant').length === 0;
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: last?.role === 'toolResult' ? `${task} started` : `${task} heard: ${lastText}` }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      if (first) {
        message.content = [{ type: 'toolCall', id: `start-${task}`, name: 'shell_start', arguments: { command: `node "${watcher.replace(/\\/g, '/')}" "${marker(task)}"` } }];
        message.stopReason = 'toolUse';
      }
      void (async () => {
        stream.push({ type: 'start', partial: message });
        const gate = last?.role === 'toolResult' && /^(busy|gone)/.test(task) ? task : undefined;
        if (gate) await new Promise<void>(resolve => {
          releases.set(gate, resolve); options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          if (options?.signal?.aborted) resolve();
        });
        if (options?.signal?.aborted) { message.stopReason = 'aborted'; stream.push({ type: 'error', reason: 'aborted', error: message }); }
        else stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message });
        stream.end();
      })();
      return stream;
    },
  });
  const shells = new ShellJobs();
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(withoutFullChat(text)); }, text => warnings.push(text), dir,
    { settings: () => ({ subagentLevels: 1, maxAgents: 8 }), shells, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  // The same wiring the profile uses (src/index.ts), with the main agent's inbox collected in `mainNotices`.
  shells.setReporter(shellReporter({ live: () => true, main: async text => { mainNotices.push(text); }, agent: (id, text) => children.shellNotice(id, text),
    failed: (what, job, error) => warnings.push(`${what} ${job.id}: ${String(error)}`) }));
  const release = (task: string) => writeFileSync(marker(task), 'go');
  const heard = (id: string) => children.messages(id).some(m => m.role === 'assistant' && /heard: \[shell [0-9a-f-]{36}\] completed/.test(textContent(m.content)));
  const cleanup = async () => { await children.close(); await shells.close(); removeDir(dir); };
  return { dir, children, shells, reports, warnings, mainNotices, releases, release, heard, cleanup };
}

test('a worker starts a shell with its own shell_start and the end arrives in its session, not the main agent\'s', async () => {
  const h = await harness();
  try {
    const [id] = await h.children.spawn([{ task: 'busy-gate' }], h.dir);
    await until(() => h.releases.has('busy-gate'));
    assert.ok(h.children.live(id)?.session.getActiveToolNames().includes('shell_start'), 'the worker has shell_start');
    assert.equal(h.shells.list().filter(j => j.mode === 'background' && j.agent === id).length, 1, 'the shell is owned by the worker');
    h.release('busy-gate');
    await until(() => h.shells.list().every(j => j.state !== 'running'));
    h.releases.get('busy-gate')!();
    await until(() => !h.children.active);
    assert.ok(h.heard(id), `the worker saw the "[shell ID]" end message: ${JSON.stringify(h.children.messages(id).map(m => textContent('content' in m ? m.content : '')))}`);
    assert.deepEqual(h.mainNotices, [], 'the main agent gets no duplicate');
    assert.ok(h.reports.every(r => !r.startsWith('[shell ')), 'no shell message reaches the main agent on its own');
  } finally { await h.cleanup(); }
});

test('a finished worker is resumed by its shell\'s end, as tell resumes it', async () => {
  const h = await harness();
  try {
    const [id] = await h.children.spawn([{ task: 'finisher' }], h.dir);
    await until(() => !h.children.active && h.reports.length === 1);
    assert.equal(h.children.history.records.get(id)?.state, 'completed');
    h.release('finisher');
    await until(() => h.reports.length === 2);
    await until(() => !h.children.active);
    assert.ok(h.heard(id), 'the resumed worker saw the end message');
    assert.match(h.reports[1], new RegExp(`^\\[${id}\\] finisher heard: \\[shell `));
    assert.deepEqual(h.mainNotices, []);
  } finally { await h.cleanup(); }
});

test('a worker that was stopped cannot take the notice: the main agent hears it, with the worker id', async () => {
  const h = await harness();
  try {
    const [id] = await h.children.spawn([{ task: 'gone-gate' }], h.dir);
    await until(() => h.releases.has('gone-gate'));
    await h.children.stop(id);
    await until(() => h.children.history.records.get(id)?.state === 'stopped');
    h.release('gone-gate');
    await until(() => h.mainNotices.length === 1);
    assert.match(h.mainNotices[0], /^\[shell [0-9a-f-]{36}\] completed/);
    assert.match(h.mainNotices[0], new RegExp(`Started by subagent ${id}, which could not take it\\.$`));
    assert.equal(h.children.history.records.get(id)?.state, 'stopped', 'a stopped worker is not resurrected by a shell');
  } finally { await h.cleanup(); }
});

test('the main agent\'s own shells still notify the main agent, and a worker cannot read or stop them', async () => {
  const h = await harness();
  try {
    const mine = h.shells.start('node -e 1', h.dir, async () => ({ output: 'MAIN-DONE', failed: false, exitCode: 0 }));
    await until(() => h.mainNotices.length === 1);
    assert.match(h.mainNotices[0], new RegExp(`^\\[shell ${mine}\\] completed`));
    const [id] = await h.children.spawn([{ task: 'busy-scope' }], h.dir);
    await until(() => h.releases.has('busy-scope'));
    const tool = h.children.live(id)!.session.getToolDefinition('shell_status')!;
    await assert.rejects(() => tool.execute('c', { id: mine }, undefined, undefined, { cwd: h.dir } as never), /Unknown shell ID/);
    h.releases.get('busy-scope')!();
    h.release('busy-scope');
    await until(() => !h.children.active);
    assert.equal(h.mainNotices.length, 1);
  } finally { await h.cleanup(); }
});
