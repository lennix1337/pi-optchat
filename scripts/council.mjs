






import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { assistantConfig, assistantRequest } from '../src/assistant-client.ts';
import { readQuotaState } from '../src/quota-health.ts';
import { loadConfig } from '../src/profiles.ts';
import { ADVISOR_MODEL, AGY_ADVISOR, advisorLine, agyAnswer, askAdvisor, debatePrompt, debateTurns, decisionChanged, offersModel, pickAdvisor } from '../src/council.ts';

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
  appendFileSync(join(dir, 'council.jsonl'), JSON.stringify({ at: new Date().toISOString(), ts: values.reply, changed: decisionChanged(text) ?? null }) + '\n');
  console.log(JSON.stringify({ channel, ts: values.reply }));
  process.exit(0);
}

const context = loadConfig(dir).councilContext;
const head = await post(`🧭 *Conselho do wake* · *${values.me}* propõe:\n${text}`);
const models = (() => { try { return readFileSync(join(homedir(), '.pi', 'agent', 'models.json'), 'utf8'); } catch { return undefined; } })();
const codex = pickAdvisor(readQuotaState(), Date.now(), offersModel(models));
const agyPc = join(homedir(), '.pi', 'agent', 'bin', 'agy-pc.mjs');
const askAgy = prompt => new Promise(resolve => {
  const child = execFile(process.execPath, [agyPc, '--ask', '--name', 'council', '--model', AGY_ADVISOR.model.slice(4), '--timeout', '240'],
    { timeout: 300_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      const answer = agyAnswer(stdout);
      resolve(answer ? { text: answer } : { error: error?.killed ? 'sem resposta em 300 s' : (stdout.trim().split('\n').slice(-2).join(' ') || 'sem saída').slice(-300) });
    });
  child.stdin.end(prompt);
});
const ask = (advisor, prompt) => advisor.account === 'agy' ? askAgy(prompt)
  : askAdvisor(['-p', '--no-session', '--no-extensions', '--no-tools', '--model', advisor.model, '--thinking', 'high', prompt]);
if (!codex) await post(`Nenhuma conta Codex com ${ADVISOR_MODEL} e cota livre agora.`, head.ts);
const transcript = [`🧭 wake: ${text}`];
const answers = [];
for (const { advisor, role } of debateTurns([codex, existsSync(agyPc) ? AGY_ADVISOR : undefined].filter(Boolean))) {
  const answer = await ask(advisor, debatePrompt(text, transcript.slice(1), role, context));
  const line = answer.text ? advisorLine(advisor, answer.text) : `🤖 *${advisor.model}* não respondeu: ${answer.error ?? 'resposta vazia'}`;
  await post(line, head.ts);
  if (answer.text) transcript.push(line);
  answers.push({ advisor, role, answer: answer.text, error: answer.text ? undefined : answer.error ?? 'empty' });
}
console.log(JSON.stringify({ channel, ts: head.ts, answers }));
if (!answers.some(a => a.answer)) process.exit(answers.length ? 3 : 0);
