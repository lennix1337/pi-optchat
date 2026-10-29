import { constants, existsSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AclInspectionTimeout, checkConfigPrivacy, prepareDatabase } from './store/privacy.ts';
import { remoteOrigins } from './channels/origins.ts';
import { piVoiceProvider, validVoiceConfig, type VoiceConfig } from './voice.ts';
import { openArtifactService } from './artifacts/service.ts';
import { validExecutorConfig, type ExecutorConfig } from './runtime/executor-config.ts';
import { DisplayLearning } from './memory/display-learning.ts';

const help = `Manual optional assistant server (Node.js >=24)
Usage: node assistant/src/main.ts --config <absolute-path> [--web]
       node assistant/src/main.ts --help

Supply a user-controlled secret JSON file outside Git, maximum 8192 bytes:
{"version":1,"profileId":"<nonblank>","databasePath":"<absolute durable path>","endpoint":"http://127.0.0.1:<port 1..65535>","token":"<nonempty ASCII printable without whitespace>"}
Optional Slack (Socket Mode, outbound connection only, no public endpoint):
"slack":{"appToken":"xapp-...","team":"T...","appId":"A...","operators":["U..."],"botToken":"xoxb-..."}
only the listed Slack users can suggest tasks; listing them is the operator's authorization.
With the optional botToken, the first operator's DMs become a chat with the OptChat session instead:
GET /v1/slack/inbox?after=<seq> queues them for the session, POST /v1/slack/send {text,threadTs} answers
in that operator's DM only, and POST /v1/slack/update {channel,ts,text} rewrites one of the bot's DM posts
(a decided approval loses its buttons).
Optional local notifications (Windows toast, fixed text per category, never task content):
"notifications":{"local":true}   true is the operator's consent; false revokes it.
Optional Google briefing (read-only; connect accounts first with assistant/scripts/google.mjs):
"google":{"connections":["<name>"],"timeZone":"<IANA>","dailyAt":"HH:MM"}
reads the named accounts' mail and agenda once a day after dailyAt; clients read it at GET /v1/briefing
and ask for a fresh one with POST /v1/briefing. Naming an account here is the operator's consent.
Optional voice uses the existing Pi Voice/F5 local settings and model (no download or cloud call):
"voice":{"piVoicePath":"<absolute installed @earendil-works/pi-voice directory>","settingsPath":"<absolute pi-voice.json>"}
Portuguese must already be selected in /voice-settings. The panel records at most 30 seconds, then shows
an editable transcript for confirmation; audio is never saved. This does not change terminal F5.
Optional tool-free Pi draft executor (off when omitted; authorizes model usage for these channels only):
"executor":{"agentDir":"<absolute Pi config/credential root>","channels":["Pessoal","Voz"]}
Only human-created tasks (and tasks of routines the operator activated) in those exact channels run.
Model usage may consume quota/cost. Without
"provider"/"model" it rotates over every logged-in account's saved default, as pi-multi-account does;
with both it uses only that route. An account limit/auth/transport error waits for the next usable
account (at most 12 switches per task). No tools, sends or provider retries; an interrupted
generation is never replayed automatically.
Optional routines (off when omitted): "routines":true
Runs the routines managed with assistant/scripts/routine.mjs. A routine starts paused; only an operator's
resume activates it. Each due slot becomes one queued task in the routine's channel (missed slots are
consolidated into one); the draft executor takes it when that channel is one of its channels.
Optional reviewed display learning: "learning":true opens only a local read-only panel view.
Propose/measure/review/apply/revert use assistant/scripts/display-learning.mjs and explicit terminal confirmation.
The retained dataset is synthetic; its score is not personal-learning efficacy. It never changes instructions or permissions.
No other fields are accepted. Keep the token out of arguments and logs.
Config and database must be in private, owner-controlled directories; existing
files and SQLite sidecars must be private. No permissions are changed.
Activation is manual and requires operator permission; this installs no service.
--web explicitly enables the browser panel on the same loopback endpoint; off by default.
Optional "webOrigins":["https://<host>"] enables the panel (as --web does) and also accepts those exact HTTPS
origins, for a proxy the operator runs (e.g. tailscale serve, to reach the panel from the phone); the listener
stays on loopback. Listing an origin is the operator's consent.
Web authentication is not native-terminal approval authority.
The client uses its owner-profile assistant.json with version, profileId, endpoint and token.
Operation (start/stop/health/backup/restore, opt-in autostart): node assistant/scripts/<name>.mjs --help.
`;

/** `channels` maps project names to channel ids; the bot reads the operator's messages there and posts reports by name. */
export type SlackConfig = { appToken: string; team: string; appId: string; operators: string[]; botToken?: string; channels?: Record<string, string> };
export type NotificationsConfig = { local: boolean };
export type GoogleConfig = { connections: string[]; timeZone: string; dailyAt: string };
export type Config = { version: 1; profileId: string; databasePath: string; endpoint: string; token: string; slack?: SlackConfig; notifications?: NotificationsConfig; google?: GoogleConfig; webOrigins?: string[]; voice?: VoiceConfig; executor?: ExecutorConfig; routines?: true; learning?: true };
const BASE_KEYS = 'databasePath,endpoint,profileId,token,version';
const OPTIONAL_KEYS = ['slack', 'notifications', 'google', 'webOrigins', 'voice', 'executor', 'routines', 'learning'];

function validWebOrigins(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 || !value.every(origin => typeof origin === 'string')) return false;
  try { return remoteOrigins(value).size === value.length; } catch { return false; }
}

function validGoogle(value: unknown): value is GoogleConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const g = value as Record<string, unknown>;
  if (Object.keys(g).sort().join(',') !== 'connections,dailyAt,timeZone' || typeof g.dailyAt !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(g.dailyAt)) return false;
  if (!Array.isArray(g.connections) || g.connections.length < 1 || g.connections.length > 10 || new Set(g.connections).size !== g.connections.length ||
      !g.connections.every(name => typeof name === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))) return false;
  if (typeof g.timeZone !== 'string' || g.timeZone.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: g.timeZone }); return true; } catch { return false; }
}

function validNotifications(value: unknown): value is NotificationsConfig {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).join(',') === 'local' &&
    typeof (value as Record<string, unknown>).local === 'boolean';
}

const OPTIONAL_CHECKS: Record<string, (value: unknown) => boolean> = { slack: validSlack, notifications: validNotifications, google: validGoogle, webOrigins: validWebOrigins, voice: validVoiceConfig, executor: validExecutorConfig, routines: value => value === true, learning: value => value === true };

function validSlack(value: unknown): value is SlackConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  const keys = Object.keys(s);
  const allowed = ['appId', 'appToken', 'botToken', 'channels', 'operators', 'team'];
  if (!keys.every(key => allowed.includes(key)) || !['appId', 'appToken', 'operators', 'team'].every(key => keys.includes(key))) return false;
  if ('botToken' in s && !(typeof s.botToken === 'string' && /^xoxb-[\x21-\x7e]+$/.test(s.botToken))) return false;
  if ('channels' in s && !('botToken' in s && validSlackChannels(s.channels))) return false;
  return typeof s.appToken === 'string' && /^xapp-[\x21-\x7e]+$/.test(s.appToken) &&
    typeof s.team === 'string' && /^T[A-Z0-9]{2,20}$/.test(s.team) &&
    typeof s.appId === 'string' && /^A[A-Z0-9]{2,20}$/.test(s.appId) &&
    Array.isArray(s.operators) && s.operators.length >= 1 && s.operators.length <= 20 &&
    s.operators.every(user => typeof user === 'string' && /^[UW][A-Z0-9]{2,20}$/.test(user));
}

function validSlackChannels(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length >= 1 && entries.length <= 20 && new Set(entries.map(([, id]) => id)).size === entries.length &&
    entries.every(([name, id]) => /^[a-z0-9][a-z0-9_-]{0,79}$/.test(name) && typeof id === 'string' && /^[CG][A-Z0-9]{2,20}$/.test(id));
}

export function readConfig(path: string): Config {
  if (!isAbsolute(path)) throw new Error('Invalid configuration path');
  // The privacy precheck assumes a quiescent, user-controlled directory.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let data: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid configuration file');
    data = Buffer.alloc(8193);
    let count = 0;
    while (count < data.length) {
      const n = readSync(fd, data, count, data.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > 8192) throw new Error('Invalid configuration');
    data = data.subarray(0, count);
  } finally { closeSync(fd); }
  const value: unknown = JSON.parse(data.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid configuration');
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).filter(key => !OPTIONAL_KEYS.includes(key)).sort().join(',');
  if (keys !== BASE_KEYS || OPTIONAL_KEYS.some(key => key in v && !OPTIONAL_CHECKS[key](v[key])) || v.version !== 1 ||
      typeof v.profileId !== 'string' || !v.profileId.trim() || typeof v.databasePath !== 'string' ||
      !isAbsolute(v.databasePath) || v.databasePath.includes('\0') || v.databasePath === ':memory:' ||
      typeof v.token !== 'string' || !/^[\x21-\x7e]+$/.test(v.token) || typeof v.endpoint !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(v.endpoint)) throw new Error('Invalid configuration');
  const port = Number(v.endpoint.slice(v.endpoint.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid configuration');
  return v as Config;
}

function privacyFailure(subject: string, error: unknown, files: string): string {
  if (error instanceof AclInspectionTimeout) return `${subject} privacy check timed out: the machine was too busy to inspect the ACL; retry.`;
  return `${subject} privacy check failed: use a private directory and ${files}; verify permissions and ACL inspection.`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); return; }
  if (!(args.length === 2 || (args.length === 3 && args[2] === '--web')) || args[0] !== '--config' || !isAbsolute(args[1])) { console.error('Usage: node assistant/src/main.ts --config <absolute-path> [--web] (or --help)'); process.exitCode = 1; return; }
  if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Assistant server requires Node.js >=24.'); process.exitCode = 1; return; }
  try { checkConfigPrivacy(args[1]); }
  catch (error) { console.error(privacyFailure('Configuration', error, 'file')); process.exitCode = 1; return; }
  let config: Config;
  try { config = readConfig(args[1]); }
  catch { console.error('Configuration unavailable or invalid (see --help).'); process.exitCode = 1; return; }
  try { prepareDatabase(config.databasePath); }
  catch (error) { console.error(privacyFailure('Database', error, 'files')); process.exitCode = 1; return; }
  const { TaskStore } = await import('./store/db.ts');
  const { createAssistantServer } = await import('./http/server.ts');
  let store: InstanceType<typeof TaskStore>;
  try { store = new TaskStore(config.databasePath, config.profileId); }
  catch { console.error('Database could not be opened.'); process.exitCode = 1; return; }
  let server: ReturnType<typeof createAssistantServer>;
  const web = args[2] === '--web' || config.webOrigins !== undefined;
  const { serviceSetup } = await import('./service-setup.ts');
  const { osKeyProtector } = await import('./secrets/protector.ts');
  const setup = () => serviceSetup(config, osKeyProtector());
  const extras = await startExtras(config, store);
  if (!extras) { store.close(); process.exitCode = 1; return; }
  let artifacts: ReturnType<typeof openArtifactService> | undefined;
  let workers: Workers | undefined;
  let learning: DisplayLearning | undefined;
  try {
    if (config.learning) {
      const path = join(dirname(config.databasePath), 'learning-display.sqlite');
      prepareDatabase(path);
      // Only read APIs are passed to the panel. Mutation authority stays in the separate trusted CLI.
      learning = new DisplayLearning({ databasePath: path, profileId: config.profileId, operatorAuthority: {} });
    }
    workers = await openWorkers(config, store);
    if (web) artifacts = openArtifactService({ databasePath: config.databasePath, profileId: config.profileId });
    server = createAssistantServer({ store, token: config.token, profileId: config.profileId, web, inspection: () => ({ learning: learning ? { current: learning.current(), proposals: learning.list() } : null, notices: extras.notices?.() ?? null }), ...(web ? { setup, artifacts, ...(config.webOrigins ? { webOrigins: config.webOrigins } : {}) } : {}), ...(config.voice ? { voice: piVoiceProvider(config.voice) } : {}), ...workers.server, ...extras.server });
  }
  catch { await workers?.close(); artifacts?.close(); learning?.close(); extras.stop(); store.close(); console.error('Server could not be initialized.'); process.exitCode = 1; return; }
  const running = workers;
  server.once('listening', () => running.start());
  serve(server, { async close() { await running.close(); artifacts?.close(); learning?.close(); extras.stop(); store.close(); } }, config);
}

type Workers = { server: { executor?: () => import('./runtime/task-executor.ts').ExecutorStatus; prompt?: import('./channels/web.ts').PromptSource }; start(): void; close(): Promise<void> };

/** The opt-in background workers: routines, and the draft executor, which also drafts tasks the routines vouch for. */
async function openWorkers(config: Config, store: import('./store/db.ts').TaskStore): Promise<Workers> {
  let routines: import('./routines/service.ts').RoutineService | undefined;
  let executor: import('./runtime/task-executor.ts').TaskExecutor | undefined;
  const close = async () => { await executor?.close(); await routines?.close(); };
  try {
    if (config.routines) {
      const { RoutineService } = await import('./routines/service.ts');
      routines = new RoutineService({ store, profileId: config.profileId, tasksDatabase: config.databasePath });
    }
    if (config.executor) {
      const { openTaskExecutor } = await import('./runtime/open-executor.ts');
      const vouching = routines;
      executor = openTaskExecutor(config, store, vouching ? origin => vouching.created(origin) : undefined);
    }
  } catch (error) { await close(); throw error; }
  const drafts = executor;
  return {
    server: drafts ? { executor: () => drafts.status(), prompt: task => drafts.prompt(task) } : {},
    // Reported once per run of failures; each keeps retrying, and health.mjs shows the executor failing meanwhile.
    start() {
      routines?.start(() => console.error('Routine pass failed; it keeps retrying.'));
      drafts?.start(() => console.error('Draft executor pass failed; it keeps retrying. See health.mjs for the current state.'));
    },
    close,
  };
}

type Notices = { stop(): void; announce(id: string, ref: string): void; list(): import('./notifications/center.ts').NotificationRecord[] };
type Briefings = { stop(): void; provider: import('./http/server.ts').BriefingProvider };

/** Optional Slack intake, local notices and Google briefing; null (after reporting which one failed) stops startup. */
async function startExtras(config: Config, store: import('./store/db.ts').TaskStore): Promise<{ stop(): void; notices?: () => import('./notifications/center.ts').NotificationRecord[]; server: { briefings?: import('./http/server.ts').BriefingProvider; slack?: import('./http/server.ts').SlackBridge } } | null> {
  let slack: Awaited<ReturnType<typeof startSlack>> | undefined;
  if (config.slack) {
    try { slack = await startSlack(config, config.slack, store); }
    catch { console.error('Slack channel could not be initialized.'); return null; }
  }
  let notices: Notices | undefined;
  if (config.notifications) {
    try { notices = await startNotifications(config, config.notifications, store); }
    catch { slack?.stop(); console.error('Notifications could not be initialized.'); return null; }
  }
  let google: Briefings | undefined;
  if (config.google) {
    try { google = await startGoogle(config, config.google, notices); }
    catch { notices?.stop(); slack?.stop(); console.error('Google briefing could not be initialized.'); return null; }
  }
  return { stop() { google?.stop(); notices?.stop(); slack?.stop(); }, ...(notices ? { notices: () => notices!.list() } : {}), server: { ...(google ? { briefings: google.provider } : {}), ...(slack?.bridge ? { slack: slack.bridge } : {}) } };
}

/** Reads the named Google accounts' mail and agenda once a day after `dailyAt`; failures are logged by code only. */
async function startGoogle(config: Config, settings: GoogleConfig, notices: Notices | undefined): Promise<Briefings> {
  const { GoogleLocal } = await import('./connectors/google-local.ts');
  const { BriefingService } = await import('./briefing/service.ts');
  const { osKeyProtector } = await import('./secrets/protector.ts');
  const dir = dirname(config.databasePath);
  for (const name of ['vault.sqlite', 'google.sqlite', 'google-gateway.sqlite', 'briefings.sqlite']) prepareDatabase(join(dir, name));
  const local = await GoogleLocal.open({ databasePath: config.databasePath, profileId: config.profileId, protector: osKeyProtector() });
  const service = new BriefingService({
    local, connections: settings.connections, timeZone: settings.timeZone, dailyAt: settings.dailyAt,
    onReady: briefing => {
      console.log(`Google briefing ${briefing.localDate}: ${briefing.items.length} items; sources ${briefing.sources.map(s => `${s.sourceId} ${s.state}`).join(', ')}.`);
      notices?.announce(`briefing-${briefing.localDate}`, `briefing-${briefing.briefingId}`);
    },
  });
  service.start(60_000, error => console.error(`Google briefing failed: ${error instanceof Error && /^[a-z][a-z_]{0,63}$/.test(error.message) ? error.message : 'error'}.`));
  return { stop() { service.stop(); local.close(); }, provider: service };
}

/** Local toasts for suggested tasks, needed input, review, finish and failure. The config flag is the consent. */
async function startNotifications(config: Config, settings: NotificationsConfig, store: import('./store/db.ts').TaskStore): Promise<Notices> {
  const { createNotificationCenter } = await import('./notifications/center.ts');
  const { TaskNotifier, windowsToast } = await import('./notifications/task-notifier.ts');
  const path = join(dirname(config.databasePath), 'notifications.sqlite');
  prepareDatabase(path);
  const authority = {};
  const center = createNotificationCenter({ databasePath: path, operatorAuthority: authority });
  center.setConsent('local', settings.local, authority);
  if (process.platform !== 'win32') console.error('Local notifications need Windows; notices stay listed but are not shown.');
  const notifier = new TaskNotifier({ store, center, channel: 'local', transport: windowsToast() });
  notifier.start(2000, () => console.error('Notification delivery failed.'));
  return {
    stop() { notifier.stop(); center.close(); },
    list() { return center.list(50); },
    // Delivered by the notifier's next pass; the same id again is a no-op, so a restart does not repeat the toast.
    announce(id, ref) { try { center.notify({ id, channel: 'local', category: 'briefing_ready', ref }); } catch { console.error('Notification could not be recorded.'); } },
  };
}

/**
 * Socket Mode intake: listed operators' messages become suggested tasks. With a bot token, DMs are a chat instead:
 * queued for the OptChat session and answered in the first operator's DM.
 */
async function startSlack(config: Config, settings: SlackConfig, store: import('./store/db.ts').TaskStore): Promise<{ stop(): void; bridge?: import('./http/server.ts').SlackBridge }> {
  const { ChannelLedger } = await import('./channels/inbound.ts');
  const { SlackChannel } = await import('./channels/slack.ts');
  const { SlackSocket } = await import('./channels/slack-socket.ts');
  const ledgerPath = join(dirname(config.databasePath), 'channels.sqlite');
  prepareDatabase(ledgerPath);
  // The operator's own configuration file is the authority that lists who may write to the assistant.
  const authority = {};
  const ledger = new ChannelLedger({ databasePath: ledgerPath, profileId: config.profileId, operatorAuthority: authority });
  ledger.replaceSenders('slack', settings.team, settings.operators, 'operador', authority);
  let bridge: import('./http/server.ts').SlackBridge | undefined;
  if (settings.botToken) {
    const { SlackRelay, SlackPoster } = await import('./channels/slack-relay.ts');
    const relayPath = join(dirname(config.databasePath), 'slack-relay.sqlite');
    prepareDatabase(relayPath);
    const relay = new SlackRelay({ databasePath: relayPath, profileId: config.profileId });
    const poster = new SlackPoster({ botToken: settings.botToken, operator: settings.operators[0], ...(settings.channels ? { channels: settings.channels } : {}) });
    relay.attach(poster);
    bridge = { relay, poster, ...(settings.channels ? { channels: settings.channels } : {}) };
  }
  const relayChannels = new Set(Object.values(settings.channels ?? {}));
  const channel = new SlackChannel({ store, ledger, profileId: config.profileId, team: settings.team, appId: settings.appId, ...(bridge ? { relay: bridge.relay, relayChannels } : {}), reviewLink: id => `${config.endpoint}/#tarefa=${encodeURIComponent(id)}` });
  const socket = new SlackSocket({ appToken: settings.appToken, accept: payload => channel.accept(payload), log: line => console.log(line) });
  socket.start();
  const closers = [socket, ledger, bridge?.relay];
  return { stop() { for (const c of closers) if (c) 'stop' in c ? c.stop() : c.close(); }, ...(bridge ? { bridge } : {}) };
}

/** Exported for the shutdown test; `main` is the only production caller. */
export function serve(server: Server, store: { close(): void | Promise<void> }, config: Config): void {
  let closing = false;
  let stopWatch: NodeJS.Timeout | undefined;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(stopWatch);
    const deadline = setTimeout(() => server.closeAllConnections(), 2000);
    server.closeIdleConnections();
    server.close(async () => {
      clearTimeout(deadline);
      try { await store.close(); } catch { console.error('Assistant resource shutdown failed.'); process.exitCode = 1; }
      console.log('Assistant stopped: admission closed, requests drained, database closed.');
      // Everything durable is closed. A remote close handshake (Slack's WebSocket waits ~10 s for its peer) must not
      // keep the process alive past the stop script's grace period; unref'd, this fires only if such a handle lingers.
      setTimeout(() => process.exit(), 1500).unref();
    });
  };
  // Set only by assistant/scripts/start.mjs: Windows has no graceful signal for a detached process, so stop.mjs
  // asks for a drain by creating this file in the private config directory.
  const stopFile = process.env.OPTCHAT_ASSISTANT_STOP_FILE;
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.once('error', (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'EADDRINUSE' ? 'Listen failed: address in use.' : 'Listen failed.');
    process.exitCode = 1;
    if (!closing) { closing = true; void Promise.resolve(store.close()).catch(() => { console.error('Assistant resource shutdown failed.'); process.exitCode = 1; }); }
  });
  server.listen(Number(config.endpoint.slice(config.endpoint.lastIndexOf(':') + 1)), '127.0.0.1', () => {
    if (stopFile && isAbsolute(stopFile)) stopWatch = setInterval(() => { if (existsSync(stopFile)) shutdown(); }, 200);
    const profile = config.profileId.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').slice(0, 200);
    console.log(`Assistant listening: profile ${profile} at ${config.endpoint}; database opened.`.replaceAll(config.token, '[redacted]'));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error('Assistant startup failed.'); process.exitCode = 1; });
}
