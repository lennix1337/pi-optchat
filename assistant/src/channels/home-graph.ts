import { spawn } from 'node:child_process';

export type HomeGraph = { nodes: { id: string; label: string }[]; edges: { from: string; to: string }[] };
const nodeIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9]{0,30}$/.test(value);

export function validHomeGraph(value: unknown): value is HomeGraph {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const graph = value as Record<string, unknown>;
  if (Object.keys(graph).some(k => k !== 'nodes' && k !== 'edges') || !Array.isArray(graph.nodes) || graph.nodes.length > 61 || !Array.isArray(graph.edges) || graph.edges.length > 90) return false;
  const nodes = graph.nodes;
  if (!nodes.every(n => n && typeof n === 'object' && !Array.isArray(n) && Object.keys(n).every(k => k === 'id' || k === 'label') && nodeIdValid(n.id) && typeof n.label === 'string' && n.label.length <= 200)) return false;
  const ids = new Set(nodes.map(n => n.id));
  return ids.size === nodes.length && graph.edges.every(e => e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).every(k => k === 'from' || k === 'to') && nodeIdValid(e.from) && nodeIdValid(e.to) && ids.has(e.from) && ids.has(e.to));
}

export function graphDot(graph: HomeGraph): string {
  if (!validHomeGraph(graph)) throw new Error('invalid_home_graph');
  const quote = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n\x00-\x1f\x7f]/g, ' ')}"`;
  return ['digraph home {', 'graph [rankdir=LR, bgcolor="white"];', 'node [shape=box, style="rounded,filled", fillcolor="#eef3fa", fontname="sans"];',
    ...graph.nodes.map(n => `${n.id} [label=${quote(n.label)}];`),
    ...graph.edges.map(e => `${e.from} -> ${e.to};`), '}'].join('\n');
}

export async function renderGraph(graph: HomeGraph, binary = process.env.OPTCHAT_DOT_PATH || 'dot'): Promise<Buffer | undefined> {
  const dot = graphDot(graph);
  return new Promise(resolve => {
    let settled = false, size = 0;
    const chunks: Buffer[] = [];
    const finish = (result?: Buffer) => { if (!settled) { settled = true; resolve(result); } };
    const child = spawn(binary, ['-Tpng'], { stdio: ['pipe', 'pipe', 'ignore'], signal: AbortSignal.timeout(2000) });
    child.on('error', () => finish());
    child.stdin.on('error', () => finish());
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4_000_000) { child.kill(); finish(); } else chunks.push(chunk);
    });
    child.on('close', code => finish(code === 0 && size ? Buffer.concat(chunks) : undefined));
    child.stdin.end(dot);
  });
}
