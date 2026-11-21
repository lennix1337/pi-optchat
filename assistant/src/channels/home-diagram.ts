import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function renderHomeDiagram(source: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'optchat-home-'));
  try {
    const input = join(dir, 'home.mmd'), output = join(dir, 'home.png');
    await writeFile(input, source, { mode: 0o600 });
    const cli = join(dirname(createRequire(import.meta.url).resolve('@mermaid-js/mermaid-cli')), 'cli.js');
    await exec(process.execPath, [cli, '-i', input, '-o', output], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const png = await readFile(output);
    if (!png.length || png.length > 10 * 1024 * 1024) throw new Error('invalid_diagram_size');
    return png;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
