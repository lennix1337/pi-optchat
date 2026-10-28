import type { IncomingMessage, ServerResponse } from 'node:http';
import { object, text } from '../contracts/validation.ts';

const maxBody = 64 * 1024;
const bodyIdleMs = 2_000;
const bodyDeadlineMs = 5_000;

export class BadRequest extends Error {}
export class Conflict extends Error {}

export function mutation<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof TypeError || (typeof error === 'object' && error !== null && 'errcode' in error && typeof error.errcode === 'number' && (error.errcode & 255) === 19)) throw new Conflict();
    throw error;
  }
}
export function shape(value: unknown, schema: Parameters<typeof object>[1]): void {
  try { object(value, schema); } catch (error) { if (error instanceof TypeError) throw new BadRequest(); throw error; }
}
export function send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
export async function readBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new BadRequest();
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    let idle: NodeJS.Timeout;
    const deadline = setTimeout(refuse, bodyDeadlineMs);
    function cleanup(): void {
      clearTimeout(idle); clearTimeout(deadline);
      req.off('data', data); req.off('end', end); req.off('error', interrupted); req.off('aborted', interrupted);
    }
    function refuse(): void { cleanup(); req.destroy(); reject(new BadRequest()); }
    function interrupted(): void { cleanup(); reject(new BadRequest()); }
    function resetIdle(): void { clearTimeout(idle); idle = setTimeout(refuse, bodyIdleMs); }
    function data(chunk: Buffer): void {
      size += chunk.length;
      if (size > maxBody) { refuse(); return; }
      chunks.push(chunk); resetIdle();
    }
    function end(): void { cleanup(); resolve(Buffer.concat(chunks)); }
    req.on('data', data); req.once('end', end); req.once('error', interrupted); req.once('aborted', interrupted);
    resetIdle();
  });
  try { return JSON.parse(bytes.toString('utf8')); } catch (error) { if (error instanceof SyntaxError) throw new BadRequest(); throw error; }
}
export function query(url: URL, allowed: string[]): void {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new BadRequest();
}
export function numberParam(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new BadRequest();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new BadRequest();
  return value;
}
export function taskIdParam(raw: string): string {
  let id: string;
  try { id = decodeURIComponent(raw); } catch (error) { if (error instanceof URIError) throw new BadRequest(); throw error; }
  if (!text(id)) throw new BadRequest();
  return id;
}
