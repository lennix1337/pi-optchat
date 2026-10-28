import { constants, fstatSync, openSync, readSync, closeSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConfigPrivacy, prepareDatabase } from './store/privacy.ts';

const help = `Manual optional assistant server (Node.js >=24)
Usage: node assistant/src/main.ts --config <absolute-path>
       node assistant/src/main.ts --help

Supply a user-controlled secret JSON file outside Git, maximum 8192 bytes:
{"version":1,"profileId":"<nonblank>","databasePath":"<absolute durable path>","endpoint":"http://127.0.0.1:<port 1..65535>","token":"<nonempty ASCII printable without whitespace>"}
No other fields are accepted. Keep the token out of arguments and logs.
Config and database must be in private, owner-controlled directories; existing
files and SQLite sidecars must be private. No permissions are changed.
Activation is manual and requires operator permission; this installs no service.
The client uses its owner-profile assistant.json with version, profileId, endpoint and token.
`;

type Config = { version: 1; profileId: string; databasePath: string; endpoint: string; token: string };
function readConfig(path: string): Config {
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
  if (Object.keys(v).sort().join(',') !== 'databasePath,endpoint,profileId,token,version' || v.version !== 1 ||
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
  if (args.length !== 2 || args[0] !== '--config' || !isAbsolute(args[1])) { console.error('Usage: node assistant/src/main.ts --config <absolute-path> (or --help)'); process.exitCode = 1; return; }
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
  try { server = createAssistantServer({ store, token: config.token, profileId: config.profileId }); }
  catch { store.close(); console.error('Server could not be initialized.'); process.exitCode = 1; return; }
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => server.closeAllConnections(), 2000);
    server.closeIdleConnections();
    server.close(() => { clearTimeout(deadline); store.close(); });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.once('error', (error: NodeJS.ErrnoException) => {
    console.error(error.code === 'EADDRINUSE' ? 'Listen failed: address in use.' : 'Listen failed.');
    process.exitCode = 1;
    if (!closing) { closing = true; store.close(); }
  });
  server.listen(Number(config.endpoint.slice(config.endpoint.lastIndexOf(':') + 1)), '127.0.0.1', () => {
    const profile = config.profileId.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').slice(0, 200);
    console.log(`Assistant listening: profile ${profile} at ${config.endpoint}; database opened.`.replaceAll(config.token, '[redacted]'));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => { console.error('Assistant startup failed.'); process.exitCode = 1; });
}
