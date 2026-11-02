import { Type } from 'typebox';
import { createReadToolDefinition } from '@earendil-works/pi-coding-agent';

// One call reads several files at once: the model asks for them in a single
// reply and Pi's read runs on each in parallel, so independent reads stop
// costing one model round trip each (scripts/tool-batching-stats.mjs).
export const READ_MANY_MAX = 10;

type Part = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Read = { execute(id: string, args: { path: string; offset?: number; limit?: number }, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown): Promise<{ content: Part[] }> };

export function readManyTool(cwd: string, read: Read = createReadToolDefinition(cwd) as unknown as Read) {
  return {
    name: 'read_many', label: 'Read files',
    description: `Read up to ${READ_MANY_MAX} files in one call, in parallel, with the same limits as read; each file's output starts with "== path". Use it instead of several read calls when the files don't depend on each other.`,
    parameters: Type.Object({
      files: Type.Array(Type.Object({
        path: Type.String({ minLength: 1 }),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }, { additionalProperties: false }), { minItems: 1, maxItems: READ_MANY_MAX }),
    }, { additionalProperties: false }),
    async execute(id: string, args: { files: { path: string; offset?: number; limit?: number }[] }, signal?: AbortSignal, _onUpdate?: unknown, ctx?: unknown) {
      const outs = await Promise.allSettled(args.files.map(f => read.execute(id, f, signal, undefined, ctx)));
      const content: Part[] = [];
      outs.forEach((o, i) => {
        content.push({ type: 'text', text: `== ${args.files[i].path}` });
        if (o.status === 'fulfilled') content.push(...o.value.content);
        else content.push({ type: 'text', text: `Error: ${o.reason instanceof Error ? o.reason.message : String(o.reason)}` });
      });
      return { content, details: { files: args.files.length, failed: outs.filter(o => o.status === 'rejected').length } };
    },
  };
}
