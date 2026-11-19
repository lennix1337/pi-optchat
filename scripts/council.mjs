// Wake council in Slack: posts the wake's candidates (stdin) to #wakes under the wake's name, asks the least used
// Codex account for a pick, an objection and a gap (one Pi print run, no tools, no session), posts its answer in the
// same thread under its own name, and prints {channel, ts, advisor, answer} as JSON. `--reply TS` posts the wake's
// decision (stdin) in that thread instead. Writes only those Slack posts.
//
// usage: node --experimental-transform-types --no-warnings scripts/council.mjs --me "<model · account>" [--reply TS] [--channel wakes] [--profile DIR] < text
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assistantConfig, assistantRequest } from '../src/assistant-client.ts';
import { readQuotaState } from '../src/quota-health.ts';
import { advisorLine, advisorPrompt, pickAdvisor } from '../src/council.ts';

const USAGE = 'usage: council.mjs --me "<model · account>" [--reply TS] [--channel wakes] [--profile DIR] < text';
const { values } = parseArgs({ options: { me: { type: 'string' }, reply: { type: 'string' }, channel: { type: 'string' }, profile: { type: 'string' } } });
const text = readFileSync(0, 'utf8').trim();
if (!values.me || !text) { console.error(USAGE); process.exit(2); }
const channel = values.channel ?? 'wakes';
const dir = values.profile ?? join(process.env.OPTCHAT_HOME || join(homedir(), '.optchat'), 'profiles', process.env.OPTCHAT_PROFILE || 'default');
const service = assistantConfig({ dir });
const post = (body, threadTs = null) => assistantRequest(service, '/v1/slack/send', { text: body, threadTs, channel }, 15_000);

if (values.reply) {
  await post(`🧭 *${values.me}* (decide): ${text}`, values.reply);
  console.log(JSON.stringify({ channel, ts: values.reply }));
  process.exit(0);
}

const head = await post(`🧭 *Conselho do wake* · *${values.me}* propõe:\n${text}`);
const advisor = pickAdvisor(readQuotaState(), Date.now());
if (!advisor) {
  await post('Nenhuma conta Codex com cota livre agora: sem conselheiro neste wake.', head.ts);
  console.log(JSON.stringify({ channel, ts: head.ts, advisor: null }));
  process.exit(0);
}
const answer = await new Promise(resolve => execFile('pi', ['-p', '--no-session', '--no-extensions', '--no-tools', '--model', advisor.model, '--thinking', 'low', advisorPrompt(text)],
  { timeout: 180_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => resolve(error ? { error: (stderr || error.message).trim().slice(-300) } : { text: stdout.trim() })));
if (!answer.text) {
  await post(`🤖 *${advisor.model}* não respondeu: ${answer.error ?? 'resposta vazia'}`, head.ts);
  console.log(JSON.stringify({ channel, ts: head.ts, advisor, error: answer.error ?? 'empty' }));
  process.exit(3);
}
await post(advisorLine(advisor, answer.text), head.ts);
console.log(JSON.stringify({ channel, ts: head.ts, advisor, answer: answer.text }));
