import type { ProcRow, Sample } from './machine-sample.ts';

export type OwnerKind = 'host' | 'machine' | 'bash' | 'shell' | 'worker' | 'mcp' | 'own' | 'external';
/** Who a process belongs to. `id` names one call or server; `group` is the cost centre it rolls up into (a worker, an MCP server, a program); `detail` is the command head of the call, for alerts. */
export interface Owner { id: string; group: string; kind: OwnerKind; detail?: string }
export interface McpSignature { name: string; tokens: string[] }

/** The kinds that are OptChat's own work for the operator: the only ones whose priority may be touched, and never the host's own process. */
export const LOWERABLE: ReadonlySet<OwnerKind> = new Set(['bash', 'shell', 'worker', 'mcp', 'own']);

const SECRET = /\b(\w*(?:key|token|secret|passw(?:or)?d|pwd|auth|credential)\w*\s*[=:]\s*)(?:Bearer\s+)?[^\s"']+|\bBearer\s+\S+|(:\/\/[^\s:@/]+:)[^\s@/]+@/gi;
/** The first line of a command, without secrets or a leading `cd dir &&`, cut to `max` characters: enough to recognise a call, never a record of it. */
export function commandHead(command: string, max = 50): string {
  const line = command.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? '';
  const head = line.replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '').replace(SECRET, (_m, key: string | undefined, url: string | undefined) => key ? `${key}…` : url ? `${url}…@` : 'Bearer …').replace(/\s+/g, ' ').trim();
  return [...head].length > max ? `${[...head].slice(0, max - 1).join('')}…` : head;
}

/** Whether `name` is a command shell: what Pi starts for each bash call. */
const SHELL_NAME = /^(?:bash|sh|cmd|powershell|pwsh|zsh)(?:\.exe)?$/i;
const CLAIM_BEFORE_MS = 2_000, CLAIM_AFTER_MS = 30_000, BOUND_BEFORE_MS = 60_000, BOUND_AFTER_MS = 2_000, REMEMBER_MS = 10 * 60_000, MCP_AFTER_RUN_MS = 30_000;

interface Claim { id: number; owner: Owner; command: string; at: number; bound?: boolean }
interface Memo { start: number; owner: Owner; seen: number }
export interface AttributorOptions {
  /** The pid of the Pi process whose trees are ours. */
  hostPid: number;
  /** The MCP servers mcp.json defines (names and the words their command lines hold); read lazily, only when an unclaimed child shows up. */
  mcp?: () => McpSignature[];
  /** The worker runs that started lately, to say which one a freshly launched MCP server serves. */
  runs?: () => { id: string; started: number }[];
}

/**
 * Says which owner each process belongs to. Owners are recorded when OptChat starts something (`claim`, `bind`); the rest follows
 * the parent links, so a descendant belongs to whoever its ancestor does. Each assignment is remembered with the process's start
 * time for ten minutes after it was last seen: Git Bash forks and then execs, so a descendant's parent is often gone already, and
 * a pid that Windows hands to another process later has a different start time and so is never taken for the old one.
 */
export class Attributor {
  private claims: Claim[] = [];
  private nextClaim = 1;
  private memo = new Map<number, Memo>();
  private bound = new Map<number, { claim: Claim; at: number }>();
  private externals = new Map<string, Owner>();
  constructor(private options: AttributorOptions) {}

  /** OptChat is about to run a command (bash call, shell_start, a worker's call) for `owner`. Returns a handle for `release`. */
  claim(owner: Owner, command: string, at: number): number {
    const claim = { id: this.nextClaim++, owner, command, at };
    this.claims.push(claim);
    return claim.id;
  }
  /** The command's job ended: its processes that are still running stay attributed to it. */
  release(id: number) { this.claims = this.claims.filter(c => c.id !== id); }
  /** A shell process of OptChat's own spawn: the claim whose command it runs (else the earliest unbound one) owns it. */
  bind(pid: number, command: string, at: number) {
    const open = this.claims.filter(c => !c.bound && at - c.at <= BOUND_BEFORE_MS && c.at <= at + BOUND_AFTER_MS);
    const claim = open.filter(c => c.command.trim() && command.includes(c.command.trim())).sort((a, b) => b.command.length - a.command.length)[0] ?? open.sort((a, b) => a.at - b.at)[0];
    if (!claim) return;
    claim.bound = true;
    this.bound.set(pid, { claim, at });
  }

  /** Every process of the sample with its owner. The Pi host and the helper have their own owners; a process outside the host's tree is external, grouped by program name. */
  attribute(sample: Sample): Map<number, Owner> {
    const now = sample.t, result = new Map<number, Owner>();
    this.claims = this.claims.filter(c => c.at > now - 6 * 3_600_000 || !c.bound);
    const live = new Map(sample.procs.map(p => [p.pid, p]));
    // Parents start before their children, so one pass in start order sees each parent's owner first.
    const ordered = [...sample.procs].sort((a, b) => a.start - b.start || a.pid - b.pid);
    for (const p of ordered) {
      if (p.pid === 0) continue;
      const known = this.memo.get(p.pid);
      let owner = known && known.start === p.start ? known.owner : undefined;
      if (!owner) owner = this.classify(p, sample, live);
      if (owner.kind !== 'external') this.memo.set(p.pid, { start: p.start, owner, seen: now });
      else this.memo.delete(p.pid);
      if (known && known.start === p.start) known.seen = now;
      result.set(p.pid, owner);
    }
    for (const [pid, memo] of this.memo) if (now - memo.seen > REMEMBER_MS) { this.memo.delete(pid); this.bound.delete(pid); }
    return result;
  }

  private classify(p: ProcRow, sample: Sample, live: Map<number, ProcRow>): Owner {
    const { hostPid } = this.options;
    if (p.pid === hostPid) return { id: 'host', group: 'Pi host', kind: 'host' };
    if (p.pid === sample.helperPid && p.ppid === hostPid) return { id: 'machine', group: 'machine sampler', kind: 'machine' };
    const bound = this.bound.get(p.pid);
    if (bound && p.start >= bound.at - BOUND_BEFORE_MS && p.start <= bound.at + BOUND_AFTER_MS) return bound.claim.owner;
    const parent = this.memo.get(p.ppid);
    if (parent && parent.start <= p.start && parent.owner.kind !== 'host' && parent.owner.kind !== 'machine') return parent.owner;
    if (p.ppid === hostPid && live.get(hostPid)) return this.directChild(p, sample.t);
    return this.external(p.name);
  }

  /** A process the host itself started that nothing recorded: an MCP server goes to its mcp.json entry, a shell to the call that began just before it, anything else to its program name. */
  private directChild(p: ProcRow, now: number): Owner {
    const cmd = p.cmd?.replace(/\\/g, '/').toLowerCase();
    if (cmd) {
      const server = (this.options.mcp?.() ?? []).find(s => s.tokens.some(token => cmd.includes(token.replace(/\\/g, '/').toLowerCase())));
      if (server) {
        const run = (this.options.runs?.() ?? []).filter(r => p.start >= r.started - 3_000 && p.start <= r.started + MCP_AFTER_RUN_MS).sort((a, b) => Math.abs(p.start - a.started) - Math.abs(p.start - b.started))[0];
        const via = run ? `worker ${run.id.slice(0, 8)}` : 'main session';
        return { id: `mcp:${server.name}:${run ? run.id.slice(0, 8) : 'main'}:${p.pid}`, group: `mcp ${server.name}`, kind: 'mcp', detail: via };
      }
    }
    if (SHELL_NAME.test(p.name)) {
      const claim = this.claims.filter(c => !c.bound && p.start >= c.at - CLAIM_BEFORE_MS && p.start <= c.at + CLAIM_AFTER_MS).sort((a, b) => a.at - b.at)[0];
      if (claim) { claim.bound = true; this.bound.set(p.pid, { claim, at: p.start }); return claim.owner; }
    }
    const name = p.name.replace(/\.exe$/i, '').toLowerCase();
    return { id: `own:${name}`, group: `host child ${name}`, kind: 'own' };
  }

  private external(name: string): Owner {
    const key = name.toLowerCase();
    let owner = this.externals.get(key);
    if (!owner) this.externals.set(key, owner = { id: `ext:${key}`, group: `external ${name}`, kind: 'external' });
    return owner;
  }
}
