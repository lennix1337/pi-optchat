// Wake council in Slack: posts the wake's candidates (stdin) to #wakes under the wake's name, asks the least used
// Codex account and agy (Gemini, through agy-pc.mjs --ask on the PC), in parallel, for a pick, an objection and a gap (one Pi print run, no tools, no session), posts its answer in the
// same thread under its own name, and prints {channel, ts, advisor, answer} as JSON. `--reply TS` posts the wake's
// decision (stdin) in that thread instead. Writes only those Slack posts.
//
// usage: node --experimental-transform-types --no-warnings scripts/council.mjs --me "<model · account>" [--reply TS] [--channel wakes] [--profile DIR] < text
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assistantConfig, assistantRequest } from '../src/assistant-client.ts';
import { readQuotaState } from '../src/quota-health.ts';
import { ADVISOR_MODEL, AGY_ADVISOR, advisorLine, agyAnswer, advisorPrompt, askAdvisor, offersModel, pickAdvisor } from '../src/council.ts';

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
const models = (() => { try { return readFileSync(join(homedir(), '.pi', 'agent', 'models.json'), 'utf8'); } catch { return undefined; } })();
const codex = pickAdvisor(readQuotaState(), Date.now(), offersModel(models));
const prompt = advisorPrompt(text);
const agyPc = join(homedir(), '.pi', 'agent', 'bin', 'agy-pc.mjs');
const askAgy = () => new Promise(resolve => {
  const child = execFile(process.execPath, [agyPc, '--ask', '--name', 'council', '--model', AGY_ADVISOR.model.slice(4), '--timeout', '240'],
    { timeout: 300_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      const answer = agyAnswer(stdout);
      resolve(answer ? { text: answer } : { error: error?.killed ? 'sem resposta em 300 s' : (stdout.trim().split('\n').slice(-2).join(' ') || 'sem saída').slice(-300) });
    });
  child.stdin.end(prompt);
});
const asks = [
  codex ? askAdvisor(['-p', '--no-session', '--no-extensions', '--no-tools', '--model', codex.model, '--thinking', 'high', prompt]).then(a => [codex, a])
    : post(`Nenhuma conta Codex com ${ADVISOR_MODEL} e cota livre agora.`, head.ts).then(() => null),
  existsSync(agyPc) ? askAgy().then(a => [AGY_ADVISOR, a]) : Promise.resolve(null),
];
const answers = [];
for (const r of await Promise.all(asks)) {
  if (!r) continue;
  const [advisor, answer] = r;
  await post(answer.text ? advisorLine(advisor, answer.text) : `🤖 *${advisor.model}* não respondeu: ${answer.error ?? 'resposta vazia'}`, head.ts);
  answers.push({ advisor, answer: answer.text, error: answer.text ? undefined : answer.error ?? 'empty' });
}
console.log(JSON.stringify({ channel, ts: head.ts, answers }));
if (!answers.some(a => a.answer)) process.exit(answers.length ? 3 : 0);
