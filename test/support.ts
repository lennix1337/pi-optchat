import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sandboxes = (['HOME', 'OPTCHAT_HOME', 'PI_CODING_AGENT_DIR'] as const).map(name => {
  const dir = mkdtempSync(join(tmpdir(), `optchat-${name.toLowerCase()}-`));
  process.env[name] = dir;
  return dir;
});
process.on('exit', () => { for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true }); });

/** Whether a fixture model's call is a compaction: it has the turns' system prompt, so only its task tells (recipe §4). */
export const isCompaction = (context: { messages: readonly { role: string; content?: unknown }[] }) =>
  context.messages.some(m => m.role === 'user' && /Compaction: (compress message|merge lines) /.test(JSON.stringify(m.content)));
