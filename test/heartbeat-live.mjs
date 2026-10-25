// PAID, live: one real heartbeat check against this machine's OptChat status file, printing the verdict and cost.
// Run only with the operator's consent: node --import tsx test/heartbeat-live.mjs [profile] [provider/model]
// Cost: one call of about 6K input and <60 output tokens.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beatSnapshot, checkBeat, heartbeatPlan } from '../src/heartbeat.ts';
import { loadConfig } from '../src/profiles.ts';

const [profile = 'swlucas05', name = 'anthropic/claude-haiku-5-5'] = process.argv.slice(2);
const version = readFileSync(join(homedir(), '.pi/agent/install/current-version'), 'utf8').trim();
const sdk = await import(pathToFileURL(join(homedir(), '.pi/agent/install/releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href);
const agent = join(homedir(), '.pi/agent');
const registry = new sdk.ModelRegistry(await sdk.ModelRuntime.create({ authPath: join(agent, 'auth.json'), modelsPath: join(agent, 'models.json'), modelsStorePath: join(agent, 'models-store.json'), refreshOnCreate: false }));

const dir = join(homedir(), '.optchat/profiles', profile);
// The status file holds the chat's newest memory lines and its operational state, as the live check would see them.
const snapshot = beatSnapshot({ view: readFileSync(join(homedir(), '.optchat/status.md'), 'utf8'), state: '', idleMinutes: 30, agents: [], shells: [],
  plan: heartbeatPlan(loadConfig(dir)) });
const [provider, model] = name.split('/');
let cost = 0, input = 0, output = 0;
const started = Date.now();
const beat = await checkBeat(registry, { provider, model, thinking: 'off' }, snapshot,
  message => { cost += message.usage?.cost?.total ?? 0; input += message.usage?.input + (message.usage?.cacheWrite ?? 0); output += message.usage?.output ?? 0; });
console.log(`${beat.wake ? 'WAKE' : 'SLEEP'} (${beat.model}, ${Date.now() - started}ms, ${input} in / ${output} out, $${cost.toFixed(4)}): ${beat.text}`);
