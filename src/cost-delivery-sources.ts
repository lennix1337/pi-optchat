import { execFile } from 'node:child_process';
import { closeSync, createReadStream, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { acceptedPr } from './accepted-pr.ts';
import type { UsageEntry } from './usage.ts';
import { USAGE_INDEX_SCHEMA, usageAmounts } from './usage-index-schema.ts';

export type Row = Pick<UsageEntry, 'session' | 'role' | 'model' | 'provider' | 'runId'> & Record<typeof usageAmounts[number], number> & { id: string; ts: number; pos: number; len: number };
export type Merge = { url: string; at: number; title: string; branch: string; repo: string };
export type Delivery = { kind: 'pr' | 'deploy'; id: string; repo: string; at: number; title: string; turn?: string; agy?: boolean };
export type Evidence = { turn?: string; direct?: boolean; run?: string; at: number };
const gh = promisify(execFile);
const link = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;
const urls = (s: string) => [...new Set(s.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) ?? [])];
const label = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
export const repoPattern = /^[\w.-]+\/[\w.-]+$/;

export function readCostLedger(dir: string, from: number, to: number, warnings: string[]): Row[] {
  const sqlite = process.getBuiltinModule('node:sqlite');
  if (!sqlite) throw new Error('node:sqlite indisponível');
  const db = new sqlite.DatabaseSync(join(dir, 'usage.db'), { readOnly: true, timeout: 5000 });
  try {
    const metadata = new Map(db.prepare('SELECT key, value FROM meta').all().map(({ key, value }) => [key, value]));
    if (metadata.get('schema') !== USAGE_INDEX_SCHEMA) throw new Error('Versão de usage.db não reconhecida');
    const rows = db.prepare(`SELECT id, ts, pos, len, session, role, provider, model, ${usageAmounts.join(', ')} FROM entries
      WHERE ts < ? AND (ts >= ? OR role IN ('subagent', 'crew')) ORDER BY pos`).all(to, from) as unknown as Row[];
    const file = join(dir, 'usage.jsonl');
    const log = openSync(file, 'r');
    let misses = 0;
    try {
      for (const row of rows) {
        if (row.role !== 'subagent' && row.role !== 'crew') continue;
        const bytes = Buffer.alloc(row.len);
        try {
          if (readSync(log, bytes, 0, row.len, row.pos) !== row.len) { misses++; continue; }
          const data = JSON.parse(bytes.toString('utf8')) as Partial<UsageEntry>;
          if (data.id !== row.id) { misses++; continue; }
          if (typeof data.runId === 'string') row.runId = data.runId;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          misses++;
        }
      }
      if (Number(metadata.get('invalid') ?? 0)) warnings.push('Há registros rejeitados pelo índice de uso.');
      if (fstatSync(log).size > Number(metadata.get('offset') ?? 0)) warnings.push('O índice de uso ainda não alcançou o fim do ledger.');
      if (misses) warnings.push(`${misses} registros de trabalhadores sem correspondência no log de uso.`);
    } finally { closeSync(log); }
    return rows;
  } finally { db.close(); }
}

function mergeOf(node: { url?: string; mergedAt?: string | number; at?: number; title?: string; headRefName?: string; branch?: string }): Merge | undefined {
  const match = typeof node.url === 'string' ? link.exec(node.url) : null;
  const at = node.at ?? Date.parse(String(node.mergedAt));
  if (match && Number.isFinite(at) && typeof node.title === 'string') return { url: match[0].toLowerCase(), at, repo: match[1], title: label(node.title), branch: node.headRefName ?? node.branch ?? '' };
}

const query = `query($q:String!,$endCursor:String){search(type:ISSUE,query:$q,first:100,after:$endCursor){
  issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest {url mergedAt title headRefName}}}}`;

export async function githubMerges(bounds: number[], scope: string): Promise<Merge[]> {
  const result: Merge[] = [];
  for (let i = 1; i < bounds.length; i++) {
    const from = new Date(bounds[i - 1]).toISOString().slice(0, 19) + 'Z';
    const to = new Date(bounds[i]).toISOString().slice(0, 19) + 'Z';
    const { stdout } = await gh('gh', ['api', 'graphql', '--paginate', '--slurp', '-f', `query=${query}`, '-f', `q=is:pr is:merged ${scope} merged:${from}..${to}`], { timeout: 45_000, maxBuffer: 8 << 20, windowsHide: true });
    const pages = JSON.parse(stdout) as { data?: { search: { issueCount: number; nodes: Parameters<typeof mergeOf>[0][] } }; errors?: unknown }[];
    if (!pages.length || pages.some(p => !p.data || p.errors || p.data.search.issueCount > 1000)) throw new Error('Busca de PRs incompleta; reduza o escopo de GitHub.');
    for (const page of pages) for (const node of page.data!.search.nodes) {
      const merge = node && mergeOf(node);
      if (merge && merge.at >= bounds[i - 1] && merge.at < bounds[i]) result.push(merge);
    }
  }
  return result;
}

export function mergesFromFile(path: string): Merge[] {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Parameters<typeof mergeOf>[0][];
  if (!Array.isArray(data)) throw new Error('Esperada lista de merges');
  return data.map(node => {
    const merge = node && mergeOf(node);
    if (!merge) throw new Error('Merge inválido');
    return merge;
  });
}

type Tool = { type: string; id: string; name: string; arguments?: { command?: unknown; action?: unknown; run?: unknown } };
type SessionEvent = { type: string; id: string; timestamp?: string; customType?: string; data?: { state?: string }; message?: { role: string; toolCallId?: string; isError?: boolean; content?: string | (Tool | { type: string; text?: string })[] } };
const branchKey = (repo: string, branch: string) => `${repo.toLowerCase()}:${branch}`;

async function* files(dir: string): AsyncGenerator<string> {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, item.name);
    if (item.isDirectory()) yield* files(file);
    else if (item.isFile() && item.name.endsWith('.jsonl')) yield file;
  }
}

export async function sessionEvidence(root: string, from: number, to: number, deployRepo?: string) {
  const turns = new Map<string, string>(), prs = new Map<string, Evidence[]>(), deploys = new Map<string, Delivery>(), agy = new Set<string>();
  let invalid = 0, unknownDeployRepo = 0;
  for await (const file of files(root)) {
    if ((await stat(file)).mtimeMs < from) continue;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    let session: string | undefined, turn: string | undefined, turnSeq = 0;
    const tools = new Map<string, Tool>();
    for await (const line of lines) {
      if (!line) continue;
      let entry: SessionEvent;
      try { entry = JSON.parse(line) as SessionEvent; } catch (error) { if (!(error instanceof SyntaxError)) throw error; invalid++; continue; }
      if (!entry || typeof entry !== 'object') { invalid++; continue; }
      if (entry.type === 'session') { session = entry.id; continue; }
      const at = Date.parse(entry.timestamp ?? '');
      if (!session || !Number.isFinite(at) || at >= to) continue;
      if (entry.type === 'custom' && entry.customType === 'optchat.run') {
        if (entry.data?.state === 'start') turn = `${session}:${entry.id ?? ++turnSeq}`;
        else if (entry.data?.state === 'end') turn = undefined;
      }
      const m = entry.message;
      if (!m || entry.type !== 'message') continue;
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        for (const c of m.content) if (c?.type === 'toolCall' && 'id' in c) tools.set(c.id, c);
      }
      if (turn && (m.role === 'assistant' || m.role === 'toolResult')) turns.set(`${session}:entry:${entry.id}:${entry.timestamp}`, turn);
      if (m.role !== 'toolResult') continue;
      const tool = m.toolCallId ? tools.get(m.toolCallId) : undefined;
      if (m.toolCallId) tools.delete(m.toolCallId);
      const command = typeof tool?.arguments?.command === 'string' ? tool.arguments.command : '';
      const text = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(c => c && 'text' in c ? c.text : '').join('\n') : '';
      const acceptance = tool?.name === 'crew' && tool.arguments?.action === 'accept' ? acceptedPr(text) : undefined;
      const manual = /(?:^|[;&|\n])\s*gh\s+pr\s+merge\b[^\r\n;&|]*/.exec(command)?.[0];
      const shipUrl = /^url: "?(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)"?\s*$/m.exec(text)?.[1];
      const ship = !!shipUrl && /\bship\.mjs\b/.test(command) && /^(?:status|auto_merge): (?:merged|queued|not_queued|pr_open|skipped)\s*$/m.test(text);
      const deployMerge = deployRepo && /\bdentai-ship(?:\.mjs)?\b/.test(command) ? /^RESUMO: ((?:#\d+\s+)+)mesclados em /m.exec(text)?.[1] : undefined;
      if (acceptance || manual || ship || deployMerge) {
        const refs = acceptance ? [acceptance.url] : ship && shipUrl ? [shipUrl] : urls(text);
        if (manual) {
          refs.push(...urls(manual));
          const n = /\bmerge\s+(\d+)\b/.exec(manual)?.[1], repo = /\s(?:-R|--repo)[= \t]+([\w.-]+\/[\w.-]+)\b/.exec(manual)?.[1];
          if (n && repo) refs.push(`https://github.com/${repo}/pull/${n}`);
        }
        if (deployMerge) for (const n of deployMerge.matchAll(/#(\d+)/g)) refs.push(`https://github.com/${deployRepo}/pull/${n[1]}`);
        const uniqueRefs = new Set(refs.map(url => url.toLowerCase()));
        const run = acceptance ? tool?.arguments?.run : undefined;
        const direct = !m.isError && ((!!acceptance && text.split(/\r?\n/, 1)[0].endsWith(': merged')) || /^(?:status|auto_merge): merged\s*$/m.test(text) || !!deployMerge || (!!manual && !/\s--auto\b/.test(manual) && !/Command exited with code [1-9]/.test(text)));
        if (!m.isError || ship) for (const id of uniqueRefs) {
          const evidence = prs.get(id) ?? [];
          evidence.push({ turn, direct, at, run: typeof run === 'string' ? run : undefined });
          prs.set(id, evidence);
        }
      }
      const deploy = /^RESUMO: ([0-9a-f]{7,40}) (no ar[^\r\n]*?|deploy terminou mas a checagem no ar FALHOU) às (\d\d:\d\d); merge [^\r\n]+, deploy [^\r\n]+, total /m.exec(text);
      if (deploy && at >= from) {
        const [, sha, verdict, clock] = deploy;
        const id = `${deployRepo ?? '?'}:${sha}:${new Date(at).toDateString()}:${clock}`;
        if (!deploys.has(id)) {
          if (!deployRepo) unknownDeployRepo++;
          deploys.set(id, { kind: 'deploy', id, repo: deployRepo ?? 'repositório não configurado', title: `${sha} ${verdict}`, at, turn });
        }
      }
      if (/^\(agy model: [\w.-]+; quota left: [^\r\n]+; conversation /m.test(text)) {
        for (const m of text.matchAll(/^==== worktree .+?[\\/]([^\\/\r\n]+)[\\/]\.?worktrees[\\/][^\r\n]+? branch ([\w./-]+)\s*$/gm)) agy.add(branchKey(m[1], m[2]));
      }
    }
  }
  return { turns, prs, deploys, agy, invalid, unknownDeployRepo };
}

export type Run = { id: string; repo: string; started: number; branch: string };
export async function runBranches(dir: string, ids: Set<string>): Promise<{ runs: Run[]; invalid: number }> {
  const runs: Run[] = [];
  let invalid = 0;
  for (const id of ids) {
    if (!/^[\w-]+$/.test(id)) { invalid++; continue; }
    let raw: string;
    try { raw = readFileSync(join(dir, 'runs', `${id}.optchat.json`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; invalid++; continue; }
    let info: { id: string; cwd: string; started: number; report?: string };
    try { info = JSON.parse(raw); } catch (error) { if (!(error instanceof SyntaxError)) throw error; invalid++; continue; }
    if (!info || info.id !== id || typeof info.cwd !== 'string' || !Number.isFinite(info.started)) { invalid++; continue; }
    const repo = info.cwd.split(/[\\/]/).filter(Boolean).at(-1)?.toLowerCase();
    const branches = typeof info.report === 'string' ? [...new Set([...info.report.matchAll(/\bbranch(?:\s+state)?\b(?:\s*[*:]\s*|\s+)+`([\w./-]+)`/gi)].map(m => m[1]))] : [];
    if (repo && branches.length === 1) runs.push({ id, repo, branch: branches[0], started: info.started });
  }
  return { runs, invalid };
}

export const repoBranch = (repo: string, branch: string) => branchKey(repo.split('/').at(-1) ?? repo, branch);
