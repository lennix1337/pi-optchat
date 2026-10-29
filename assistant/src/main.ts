import { constants, existsSync, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConfigPrivacy, prepareDatabase } from './store/privacy.ts';

const help = `Manual optional assistant server (Node.js >=24)
Usage: node assistant/src/main.ts --config <absolute-path> [--web]
       node assistant/src/main.ts --help

Supply a user-controlled secret JSON file outside Git, maximum 8192 bytes:
{"version":1,"profileId":"<nonblank>","databasePath":"<absolute durable path>","endpoint":"http://127.0.0.1:<port 1..65535>","token":"<nonempty ASCII printable without whitespace>"}
Optional Slack (Socket Mode, outbound connection only, no public endpoint):
"slack":{"appToken":"xapp-...","team":"T...","appId":"A...","operators":["U..."]}
only the listed Slack users can suggest tasks; listing them is the operator's authorization.
Optional local notifications (Windows toast, fixed text per category, never task content):
"notifications":{"local":true}   true is the operator's consent; false revokes it.
No other fields are accepted. Keep the token out of arguments and logs.
Config and database must be in private, owner-controlled directories; existing
files and SQLite sidecars must be private. No permissions are changed.
Activation is manual and requires operator permission; this installs no service.
--web explicitly enables the browser panel on the same loopback endpoint; off by default.
Web authentication is not native-terminal approval authority. No remote/mobile exposure.
The client uses its owner-profile assistant.json with version, profileId, endpoint and token.
Operation (start/stop/health/backup/restore, opt-in autostart): node assistant/scripts/<name>.mjs --help.
`;

export type SlackConfig = { appToken: string; team: string; appId: string; operators: string[] };
export type NotificationsConfig = { local: boolean };
export type Config = { version: 1; profileId: string; databasePath: string; endpoint: string; token: string; slack?: SlackConfig; notifications?: NotificationsConfig };
const BASE_KEYS = 'databasePath,endpoint,profileId,token,version';
const OPTIONAL_KEYS = ['slack', 'notifications'];

function validNotifications(value: unknown): value is NotificationsConfig {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).join(',') === 'local' &&
    typeof (value as Record<string, unknown>).local === 'boolean';
}

function validSlack(value: unknown): value is SlackConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return Object.keys(s).sort().join(',') === 'appId,appToken,operators,team' &&
    typeof s.appToken === 'string' && /^xapp-[\x21-\x7e]+$/.test(s.appToken) &&
    typeof s.team === 'string' && /^T[A-Z0-9]{2,20}$/.test(s.team) &&
    typeof s.appId === 'string' && /^A[A-Z0-9]{2,20}$/.test(s.appId) &&
    Array.isArray(s.operators) && s.operators.length >= 1 && s.operators.length <= 20 &&
    s.operators.every(user => typeof user === 'string' && /^[UW][A-Z0-9]{2,20}$/.test(user));
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
  if (keys !== BASE_KEYS || ('slack' in v && !validSlack(v.slack)) || ('notifications' in v && !validNotifications(v.notifications)) || v.version !== 1 ||
      typeof v.profileId !== 'string' || !v.profileId.trim() || typeof v.databasePath !== 'string' ||
      !isAbsolute(v.databasePath) || v.databasePath.includes('\0') || v.databasePath === ':memory:' ||
      typeof v.token !== 'string' || !/^[\x21-\x7e]+$/.test(v.token) || typeof v.endpoint !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(v.endpoint)) throw new Error('Invalid configuration');
  const port = Number(v.endpoint.slice(v.endpoint.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid configuration');
  return v as Config;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); return; }
  if (!(args.length === 2 || (args.length === 3 && args[2] === '--web')) || args[0] !== '--config' || !isAbsolute(args[1])) { console.error('Usage: node assistant/src/main.ts --config <absolute-path> [--web] (or --help)'); process.exitCode = 1; return; }
  if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Assistant server requires Node.js >=24.'); process.exitCode = 1; return; }
  try { checkConfigPrivacy(args[1]); }
  catch { console.error('Configuration privacy check failed: use a private directory and file; verify permissions and ACL inspection.'); process.exitCode = 1; return; }
  let config: Config;
  try { config = readConfig(args[1]); }
  catch { console.error('Configuration unavailable or invalid (see --help).'); process.exitCode = 1; return; }
  try { prepareDatabase(config.databasePath); }
  catch { console.error('Database privacy check failed: use a private directory and files; verify permissions and ACL inspection.'); process.exitCode = 1; return; }
  const { TaskStore } = await import('./store/db.ts');
  const { createAssistantServer } = await import('./http/server.ts');
  let store: InstanceType<typeof TaskStore>;
  try { store = new TaskStore(config.databasePath, config.profileId); }
  catch { console.error('Database could not be opened.'); process.exitCode = 1; return; }
  let server: ReturnType<typeof createAssistantServer>;
  const web = args[2] === '--web';
  const { defaultComponents } = await import('./setup.ts');
  const { osKeyProtector } = await import('./secrets/protector.ts');
  const setup = () => defaultComponents({ databasePath: config.databasePath, protector: osKeyProtector() });
  try { server = createAssistantServer({ store, token: config.token, profileId: config.profileId, web, ...(web ? { setup } : {}) }); }
  catch { store.close(); console.error('Server could not be initialized.'); process.exitCode = 1; return; }
  const extras = await startExtras(config, store);
  if (!extras) { server.close(); store.close(); process.exitCode = 1; return; }
  serve(server, { close() { extras.stop(); store.close(); } }, config);
}

/** Optional Slack intake and local notices; null (after reporting which one failed) stops startup. */
async function startExtras(config: Config, store: import('./store/db.ts').TaskStore): Promise<{ stop(): void } | null> {
  let slack: { stop(): void } | undefined;
  if (config.slack) {
    try { slack = await startSlack(config, config.slack, store); }
    catch { console.error('Slack channel could not be initialized.'); return null; }
  }
  let notices: { stop(): void } | undefined;
  if (config.notifications) {
    try { notices = await startNotifications(config, config.notifications, store); }
    catch { slack?.stop(); console.error('Notifications could not be initialized.'); return null; }
  }
  return { stop() { notices?.stop(); slack?.stop(); } };
}

/** Local toasts for suggested tasks, needed input, review, finish and failure. The config flag is the consent. */
async function startNotifications(config: Config, settings: NotificationsConfig, store: import('./store/db.ts').TaskStore): Promise<{ stop(): void }> {
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
  return { stop() { notifier.stop(); center.close(); } };
}

/** Socket Mode intake: listed operators' messages become suggested tasks; nothing is posted back. */
async function startSlack(config: Config, settings: SlackConfig, store: import('./store/db.ts').TaskStore): Promise<{ stop(): void }> {
  const { ChannelLedger } = await import('./channels/inbound.ts');
  const { SlackChannel } = await import('./channels/slack.ts');
  const { SlackSocket } = await import('./channels/slack-socket.ts');
  const ledgerPath = join(dirname(config.databasePath), 'channels.sqlite');
  prepareDatabase(ledgerPath);
  // The operator's own configuration file is the authority that lists who may write to the assistant.
  const authority = {};
  const ledger = new ChannelLedger({ databasePath: ledgerPath, profileId: config.profileId, operatorAuthority: authority });
  ledger.replaceSenders('slack', settings.team, settings.operators, 'operador', authority);
  const channel = new SlackChannel({ store, ledger, profileId: config.profileId, team: settings.team, appId: settings.appId, reviewLink: id => `${config.endpoint}/#tarefa=${encodeURIComponent(id)}` });
  const socket = new SlackSocket({ appToken: settings.appToken, accept: payload => channel.accept(payload), log: line => console.log(line) });
  socket.start();
  return { stop() { socket.stop(); ledger.close(); } };
}

/** Exported for the shutdown test; `main` is the only production caller. */
export function serve(server: Server, store: { close(): void }, config: Config): void {
  let closing = false;
  let stopWatch: NodeJS.Timeout | undefined;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    clearInterval(stopWatch);
    const deadline = setTimeout(() => server.closeAllConnections(), 2000);
    server.closeIdleConnections();
    server.close(() => {
      clearTimeout(deadline); store.close(); console.log('Assistant stopped: admission closed, requests drained, database closed.');
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
    if (!closing) { closing = true; store.close(); }
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
