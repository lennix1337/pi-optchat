// PAID, live: replays one real gated call from a Pi session file through the advisor, several times.
// Run only with the operator's consent:
//   node --import tsx test/effect-advisor-replay.mjs <session.jsonl> <tool> [runs=5] [provider/model]
// Picks the last call of <tool> in the session and the operator's four messages before it, as the gate saw them.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { adviseEffect } from '../src/effect-advisor.ts';

const [file, tool, runs = '5', name = 'anthropic/claude-haiku-5-5'] = process.argv.slice(2);
if (!file || !tool) throw new Error('usage: effect-advisor-replay.mjs <session.jsonl> <tool> [runs] [provider/model]');

const version = readFileSync(join(homedir(), '.pi/agent/install/current-version'), 'utf8').trim();
const sdk = await import(pathToFileURL(join(homedir(), '.pi/agent/install/releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
const agent = join(homedir(), '.pi/agent');
const registry = new sdk.ModelRegistry(await sdk.ModelRuntime.create({ authPath: join(agent, 'auth.json'), modelsPath: join(agent, 'models.json'), modelsStorePath: join(agent, 'models-store.json'), refreshOnCreate: false }));

const textOf = content => typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
const entries = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(e => e.type === 'message');
let call, at = -1;
entries.forEach((entry, i) => {
  if (entry.message.role !== 'assistant' || !Array.isArray(entry.message.content)) return;
  for (const block of entry.message.content) if (block.type === 'toolCall' && block.name === tool) { call = block; at = i; }
});
if (!call) throw new Error(`no ${tool} call in ${file}`);
const requests = entries.slice(0, at).filter(e => e.message.role === 'user').map(e => textOf(e.message.content).replace(/\s+/g, ' ').trim())
  .filter(text => text && !/^approve-(?:effect|standing)\b/.test(text)).slice(-4).map(text => text.length > 600 ? `${text.slice(0, 599)}\u2026` : text);

const [provider, model] = name.split('/');
let approved = 0, cost = 0;
for (let i = 0; i < Number(runs); i++) {
  const verdict = await adviseEffect(registry, { provider, model, thinking: 'off' },
    { kind: 'paid model call', tool, input: call.arguments, cwd: 'C:/Users/swluc', requests }, message => { cost += message.usage?.cost?.total ?? 0; });
  if (verdict.approve) approved++;
  console.log(`${verdict.approve ? 'APPROVE' : 'DENY   '} ${verdict.reason}`);
}
console.log(`${name}: ${approved}/${runs} approved, $${cost.toFixed(4)}; requests seen: ${requests.length}`);
