// Shared CLI shell for the assistant ops scripts: strict arguments, one JSON result line on stdout, fixed exit codes.
// Exit 0 = the requested state holds, 1 = refused or unhealthy, 2 = usage. Errors print codes and diagnostics, never tokens.
import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';

export function cli(usage, options, run) {
  if (Number(process.versions.node.split('.')[0]) < 24) { console.error('Assistant ops scripts require Node.js >=24.'); process.exit(2); }
  let values, positionals;
  try { ({ values, positionals } = parseArgs({ options: { ...options, help: { type: 'boolean' } }, allowPositionals: true, strict: true })); }
  catch { console.error(usage); process.exit(2); }
  if (values.help) { process.stdout.write(`${usage}\n`); return; }
  for (const [name, spec] of Object.entries(options)) {
    const value = values[name];
    if ((spec.required && value === undefined) || (spec.path && value !== undefined && !isAbsolute(value))) { console.error(usage); process.exit(2); }
  }
  run(values, positionals).then(({ exitCode = 0, ...result }) => {
    console.log(JSON.stringify(result));
    process.exitCode = exitCode;
  }, error => {
    // Library failures are fixed codes; anything else is reported as unexpected with its message on stderr only.
    const message = error instanceof Error ? error.message : String(error);
    const code = /^[a-z][a-z_]*$/.test(message) ? message : 'unexpected';
    console.log(JSON.stringify({ result: 'error', code }));
    const detail = typeof error?.detail === 'string' ? error.detail : code === 'unexpected' ? message : '';
    if (detail) console.error(detail);
    process.exitCode = 1;
  });
}
