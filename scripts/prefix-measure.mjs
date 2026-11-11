#!/usr/bin/env node
// Measures what the main agent sends on EVERY request (system prompt, instruction sections, skill catalogue,
// tool declarations) by running the real Pi CLI with the live package set against a local fake Anthropic
// endpoint that records the request body. No provider call, no live profile writes: everything runs in a
// throw-away agent dir and OptChat home under os.tmpdir(); the live ~/.pi/agent and profile are only read.
//
//   node scripts/prefix-measure.mjs [--optchat <dir>] [--cwd <dir>] [--out file.json] [--keep]
//
// --optchat: the pi-optchat checkout to load in place of the one in settings.json (default: this repo).
// Output: JSON with bytes of system text, tool schemas (per tool, per source) and the instruction sections.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const optchatDir = resolve(flag('optchat', join(here, '..')));
const cwd = resolve(flag('cwd', 'C:/projetos/pi-optchat'));
const outFile = flag('out');
const profileName = flag('profile', 'swlucas05');
const liveAgent = join(homedir(), '.pi', 'agent');
const liveHome = join(homedir(), '.optchat');
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8');

const bodies = [];
// --probe '<javascript>': the first answer is a codemode call running it, so the second request carries its result.
const probe = flag('probe');
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try { bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { bodies.push({ unparsable: true }); }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send('message_start', { message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    if (probe && bodies.length === 1) {
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_probe', name: 'codemode', input: {} } });
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ code: probe }) } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } });
      send('message_stop', {});
      return res.end();
    }
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
    send('message_stop', {});
    res.end();
  });
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const port = server.address().port;

const root = mkdtempSync(join(tmpdir(), 'lean-measure-'));
const agent = join(root, 'agent'), home = join(root, 'home');
mkdirSync(agent, { recursive: true });
const settings = JSON.parse(readFileSync(join(liveAgent, 'settings.json'), 'utf8'));
const absolute = source => {
  const path = typeof source === 'string' ? source : source.source;
  const fixed = /^(npm:|git:|https?:)/.test(path) ? path : resolve(liveAgent, path).replaceAll('\\', '/');
  return typeof source === 'string' ? fixed : { ...source, source: fixed };
};
settings.packages = settings.packages.map(absolute).map(source => (typeof source === 'string' ? source : source.source).replaceAll('\\', '/').toLowerCase() === 'c:/projetos/pi-optchat'
  ? optchatDir.replaceAll('\\', '/') : source);
for (const key of ['defaultProvider', 'defaultModel']) delete settings[key];
delete settings.shellCommandPrefix; delete settings.extensionChangelogVersions;
settings.quietStartup = true; settings.lastChangelogVersion = readFileSync(join(liveAgent, 'install', 'current-version'), 'utf8').trim();
writeFileSync(join(agent, 'settings.json'), JSON.stringify(settings, null, 2));
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { leanfake: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'synthetic', api: 'anthropic-messages',
  models: [{ id: 'fake-opus', name: 'Fake', reasoning: true, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8000 }] } } }));
writeFileSync(join(agent, 'auth.json'), '{}');
for (const file of ['AGENTS.md']) if (existsSync(join(liveAgent, file))) cpSync(join(liveAgent, file), join(agent, file));
for (const dir of ['skills']) if (existsSync(join(liveAgent, dir))) cpSync(join(liveAgent, dir), join(agent, dir), { recursive: true });
for (const dir of ['npm', 'git']) if (existsSync(join(liveAgent, dir))) symlinkSync(join(liveAgent, dir), join(agent, dir), 'junction');

const profile = join(home, 'profiles', profileName);
mkdirSync(profile, { recursive: true });
cpSync(join(liveHome, 'profiles', profileName, 'AGENTS.md'), join(profile, 'AGENTS.md'));
const config = JSON.parse(readFileSync(join(liveHome, 'profiles', profileName, 'config.json'), 'utf8'));
// Same profile, minus everything that would reach out (heartbeat wakes, daily retro, sync).
Object.assign(config, { heartbeatMinutes: 0, dailyRetro: 'off', syncStatus: false, syncAiMemory: false, syncOptMem: false });
writeFileSync(join(profile, 'config.json'), JSON.stringify(config, null, 2));
writeFileSync(join(home, 'last-profile'), profileName);

const cli = join(liveAgent, 'install', 'releases', readFileSync(join(liveAgent, 'install', 'current-version'), 'utf8').trim(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js');
const child = spawn(process.execPath, [cli, '-p', 'say ok', '--no-session', '--offline', '--no-mcp', '--model', 'leanfake/fake-opus', '--thinking', 'high', '--optchat-profile', profileName, '--optchat-connect', 'off'], {
  cwd, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PI_CODING_AGENT_DIR: agent, OPTCHAT_HOME: home, PI_OFFLINE: '1', PI_TELEMETRY: '0' } });
let log = '';
child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
const timer = setTimeout(() => child.kill(), 90_000);
const code = await new Promise(ok => child.on('close', ok));
clearTimeout(timer); server.close();

if (probe) {
  const last = bodies.at(-1)?.messages?.at(-1);
  console.log('probe result:', JSON.stringify(last?.content ?? last).slice(0, 2000));
}
const main = bodies.find(body => Array.isArray(body.tools) || body.system);
if (!main) { console.error(`no request captured (exit ${code})\n${log.slice(-3000)}`); process.exit(1); }
const system = typeof main.system === 'string' ? [main.system] : (main.system ?? []).map(block => block.text ?? '');
const systemText = system.join('\n');
const tags = {};
for (const match of systemText.matchAll(/<([a-z_]+)\b[^>]*>([\s\S]*?)<\/\1>/g)) tags[match[1]] = (tags[match[1]] ?? 0) + bytes(match[2]);
const tools = (main.tools ?? []).map(tool => ({ name: tool.name, bytes: bytes(tool), descriptionBytes: bytes(tool.description), schemaBytes: bytes(tool.input_schema) })).sort((a, b) => b.bytes - a.bytes);
const result = {
  optchat: optchatDir, cwd, exit: code, requests: bodies.length,
  systemBytes: bytes(systemText), toolSchemaBytes: bytes(main.tools ?? []), toolCount: tools.length,
  fixedPrefixBytes: bytes(systemText) + bytes(main.tools ?? []),
  estimatedPrefixTokens: Math.round((bytes(systemText) + bytes(main.tools ?? [])) / 4),
  tags, tools, systemText, declarations: main.tools ?? [],
};
if (outFile) writeFileSync(outFile, JSON.stringify(result, null, 1));
const { systemText: _omit, tools: _tools, declarations: _declarations, ...summary } = result;
console.log(JSON.stringify({ ...summary, top: tools.slice(0, 15) }, null, 1));
if (!args.includes('--keep')) rmSync(root, { recursive: true, force: true }); else console.error(`kept ${root}`);
process.exit(0);
