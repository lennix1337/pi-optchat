// A stdio MCP server shaped like `npx -y @sentry/mcp-server`: it keeps running when its stdin closes and has a child process of its own.
// It logs `start <pid>` and `child <pid>` to the file in argv[2], so a test can tell whether either outlived the connection.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = process.argv[2], note = line => { if (log) appendFileSync(log, `${line}\n`); };
note(`start ${process.pid}`);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
child.once('spawn', () => note(`child ${child.pid}`));
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === 'initialize') send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stubborn', version: '1.0.0' } } });
  else if (method === 'tools/list') send({ id, result: { tools: [] } });
  else send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
});
setInterval(() => {}, 1000); // stdin closing must not end it
