import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export type IssueReference = { repo: string; number: number };

export type IssueAliases = Record<string, string>;
const ttl = 15 * 60_000;

export function issueReferences(text: string, aliases: IssueAliases = {}): IssueReference[] | undefined {
  const refs: IssueReference[] = [];
  const remaining = text.replace(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)(?!\d)/gi, (_url, owner: string, repo: string, number: string) => {
    refs.push({ repo: `${owner}/${repo}`, number: Number(number) });
    return ' ';
  });
  const numbers = [...remaining.matchAll(/#(\d+)\b/g)].map(match => Number(match[1]));
  if (numbers.length) {
    const repos = new Set(Object.entries(aliases).filter(([pattern]) => new RegExp(pattern, 'i').test(remaining)).map(([, repo]) => repo));
    if (repos.size !== 1) return undefined;
    const repo = [...repos][0];
    refs.push(...numbers.map(number => ({ repo, number })));
  }
  return [...new Map(refs.map(ref => [`${ref.repo.toLowerCase()}#${ref.number}`, ref])).values()];
}

const execFileAsync = promisify(execFile);
export async function ghIssueState(ref: IssueReference, run: (command: string, args: string[], options: { timeout: number; windowsHide: boolean }) => Promise<{ stdout: string }> = execFileAsync): Promise<'open' | 'closed' | undefined> {
  const { stdout } = await run('gh', ['api', `repos/${ref.repo}/issues/${ref.number}`, '--jq', '.state'], { timeout: 10_000, windowsHide: true });
  const state = stdout.trim();
  if (state === 'open' || state === 'closed') return state;
  throw new Error('unexpected GitHub issue state');
}

/** Where a failed lookup goes: it runs in the background while the TUI owns the terminal, so it must never print. */
export type LookupFailure = (key: string, error: unknown) => void;

export class IssueStateCache {
  private entries = new Map<string, { state: 'open' | 'closed' | undefined; at: number }>();
  private pending = new Map<string, Promise<void>>();
  constructor(private resolve: (ref: IssueReference) => Promise<'open' | 'closed' | undefined> = ghIssueState, private now = Date.now, private failed: LookupFailure = () => {}, private aliases: () => IssueAliases = () => ({})) {}
  private key(ref: IssueReference) { return `${ref.repo.toLowerCase()}#${ref.number}`; }
  async refresh(text: string): Promise<void> {
    const refs = issueReferences(text, this.aliases());
    if (!refs) return;
    await Promise.all(refs.map(async ref => {
      const key = this.key(ref), entry = this.entries.get(key);
      if (entry && this.now() - entry.at < ttl) return;
      let pending = this.pending.get(key);
      if (!pending) {
        pending = (async () => {
          try { this.entries.set(key, { state: await this.resolve(ref), at: this.now() }); }
          catch (error) {
            this.failed(key, error);
            this.entries.set(key, { state: undefined, at: this.now() });
          }
        })().finally(() => this.pending.delete(key));
        this.pending.set(key, pending);
      }
      await pending;
    }));
  }
  hint(text: string): string | undefined {
    const refs = issueReferences(text, this.aliases());
    if (!refs?.length || !refs.every(ref => {
      const entry = this.entries.get(this.key(ref));
      return entry?.state === 'closed' && this.now() - entry.at < ttl;
    })) return undefined;
    return `⚠ all cited issues closed (${refs.map(ref => `#${ref.number}`).join(' ')}): verify and close`;
  }
}
