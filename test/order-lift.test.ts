import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import { checkoutSlug } from '../src/checkout-slug.ts';
import type { Repo } from '../src/autonomy.ts';
import { orderGrantFor, readOperationalState, updateOperationalState, type OperationalUpdate } from '../src/operational-state.ts';
import { withTempDir } from './support.ts';

/** The live profile's autonomy.json as it stood on 2026-10-30, copied here; the operator's own file is never read or written. */
const LIVE_CONTRACT = {
  version: 1, default: 'ask', rules: [
    { action: 'force-push', scope: ['*'], level: 'ask', note: 'never force without the operator' },
    { action: 'deploy', scope: ['*'], level: 'ask', note: 'deploys need an explicit OK naming the release' },
    { action: 'production-write', scope: ['*'], level: 'ask', note: 'production data and services need an explicit OK' },
    { action: 'publish', scope: ['*'], level: 'ask', note: 'releases and packages need an explicit OK' },
    { action: 'global-install', scope: ['*'], level: 'ask', note: 'machine changes need an OK' },
    { action: 'paid', scope: ['subagent'], level: 'report', note: 'delegated agents on the plan, reported' },
    { action: 'paid', scope: ['*'], level: 'ask', note: 'direct model runs (bench, pi -p, A/B) cost money' },
    { action: 'discard', scope: ['worktree-cleanup'], level: 'free', note: 'merged worktrees may always go (2026-10-27)' },
    { action: 'discard', scope: ['*'], level: 'ask', note: 'discarding work needs an OK' },
    { action: 'recursive-delete', scope: ['*/node_modules', '*/target', '*/target-*', '*/__pycache__', '*/.repro', '*/.repro/*', '*/dist', '*/.next', 'c:/projetos/local-validation/*', '*/worktrees/_tmp/*', 'c:/tmp/*'], level: 'free', note: 'generated, build or scratch folders' },
    { action: 'recursive-delete', scope: ['*'], level: 'ask', note: 'outside temp, build and scratch folders needs an OK' },
    { action: 'push', scope: ['lennix1337/*', 'tecnologia-ai/*'], level: 'free', note: 'branches and PRs are always allowed' },
    { action: 'push-main', scope: ['lennix1337/pi-optchat', 'lennix1337/pi-subagents', 'lennix1337/pi-goal-x', 'lennix1337/pi-multi-account', 'lennix1337/pi-ripwire', 'lennix1337/pi-ripwire-but-better', 'lennix1337/pi-release-progress', 'lennix1337/ripwire', 'lennix1337/dotfiles'], level: 'report', note: 'Pi forks and dotfiles to main after gates' },
    { action: 'merge', scope: ['lennix1337/*'], level: 'report', note: 'own-repo PRs after review and checks, no deploy' },
    { action: 'merge', scope: ['tecnologia-ai/*'], level: 'ask', note: 'DentAI merges need a per-PR OK' },
  ],
};

/** The checkout C:/projetos/dentai-mono as the operator has it: its origin is the DentAI repository. */
const REPO: Repo = {
  slug: path => path === 'c:/projetos/dentai-mono' ? 'tecnologia-ai/dentai' : undefined,
  branch: path => path === 'c:/projetos/dentai-mono' ? 'main' : undefined,
  script: () => undefined,
};
const fixtureSlugs = (folder: string) => folder === 'c:/projetos/dentai-mono' ? 'tecnologia-ai/dentai' : undefined;

const MERGE = String.raw`cd C:/projetos/dentai-mono && gh pr merge 127 --repo tecnologia-ai/dentai --squash 2>&1 | tail -3; gh pr view 127 --repo tecnologia-ai/dentai --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid)"'`;
const DEPLOY = String.raw`cd C:/projetos/dentai-mono && pwsh -NoProfile -File scripts/release/deploy-changed.ps1 -Commit 9781524fc90c09a4acfe8f92dc28a6862d548360 -PolicyFile "C:\projetos\local-validation\runs\denta-102\release-policy-9781524f.json"`;
const GRANT = { action: 'merge' as const, scope: 'C:/projetos/dentai-mono', allow: true, until: 'done' };
const ORDER = {
  kind: 'authorization' as const, text: 'pode fazer o merge e deploy', sourceMessageId: '86853', grant: GRANT,
} satisfies OperationalUpdate;
const QUOTES: Record<string, string> = { '86853': 'pode fazer o merge e deploy' };

/** The call was refused, and the refusal says the operator decides under autonomy.json (not some other failure). */
function waitsForOperator(refusal: { block?: boolean; reason?: string } | undefined) {
  assert.equal(refusal?.block, true, 'the call waits');
  assert.match(refusal!.reason!, /autonomy\.json says this waits for the operator/);
}

/**
 * The gate as index.ts wires it in risk mode: the contract in the profile folder, and the operator's typed orders read
 * back from operational-state.json (an unreadable file lifts nothing). Every call runs in the owning session.
 */
function session(directory: string, quotes: Record<string, string>, { checkoutSlug: slugOf = fixtureSlugs, now = Date.now }: { checkoutSlug?: (folder: string) => string | undefined; now?: () => number } = {}) {
  writeFileSync(join(directory, 'autonomy.json'), JSON.stringify(LIVE_CONTRACT));
  const file = join(directory, 'operational-state.json');
  const hooks = new Map<string, (...args: any[]) => any>();
  const advised: string[] = [];
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled: true, mode: 'risk', bell: () => {}, repo: REPO, contractDir: () => directory,
    orderGrant: effect => {
      try { return orderGrantFor(readOperationalState(file), effect, id => quotes[id], now(), slugOf); }
      catch { return undefined; }
    },
    advisor: async request => {
      advised.push(String((request.input as { command?: string }).command ?? request.tool));
      return { approve: false, reason: 'the advisor refuses', model: 'test' };
    } });
  const ctx = { cwd: 'C:/projetos/pi-optchat', sessionManager: { getSessionId: () => 'owner', getBranch: () => [] }, ui: { notify: () => {}, setWidget: () => {} } };
  return {
    file, advised,
    order: (update: OperationalUpdate) => updateOperationalState(file, update),
    run: (tool: string, command: string, cwd = 'C:/projetos/pi-optchat') => hooks.get('tool_call')!({ toolName: tool, toolCallId: `${tool}:${command}`, input: { command } }, { ...ctx, cwd }),
  };
}

test('the 2026-10-30 order "pode fazer o merge e deploy", recorded as one merge grant, runs both calls it names with no approval, shell_start included', () => withTempDir('optchat-order-lift-', async directory => {
  const s = session(directory, QUOTES);
  s.order(ORDER);
  assert.equal(await s.run('bash', MERGE), undefined, 'the merge runs');
  assert.equal(await s.run('shell_start', DEPLOY), undefined, 'the deploy runs');
  assert.deepEqual(s.advised, [], 'the advisor is never asked about what the order covers');
}));

test('"faz o merge mas não o deploy" lifts the merge and nothing else', () => withTempDir('optchat-order-lift-', async directory => {
  const s = session(directory, { '2': 'faz o merge mas não o deploy' });
  s.order({ ...ORDER, text: 'faz o merge mas não o deploy', sourceMessageId: '2' });
  assert.equal(await s.run('bash', MERGE), undefined, 'the merge runs');
  waitsForOperator(await s.run('shell_start', DEPLOY));
  assert.deepEqual(s.advised, []);
}));

test('an order lifts nothing past its 12-hour TTL', () => withTempDir('optchat-order-lift-', async directory => {
  const s = session(directory, QUOTES, { now: () => Date.now() + 13 * 3_600_000 });
  s.order(ORDER);
  waitsForOperator(await s.run('shell_start', DEPLOY));
  waitsForOperator(await s.run('bash', MERGE));
}));

test('an order lifts nothing for another repository, a quote that differs from the record, a bare "sim", or an unreadable state file', () => withTempDir('optchat-order-lift-', async directory => {
  const s = session(directory, QUOTES);
  s.order(ORDER);
  waitsForOperator(await s.run('bash', 'gh pr merge 9 --repo tecnologia-ai/other --squash'));
  const other = session(directory, { ...QUOTES, '86853': 'pode fazer o merge e deploy, de verdade' });
  waitsForOperator(await other.run('shell_start', DEPLOY));
  waitsForOperator(await session(directory, {}).run('bash', MERGE));
  const sim = session(directory, { '3': 'sim' });
  sim.order({ ...ORDER, text: 'sim', sourceMessageId: '3' });
  waitsForOperator(await sim.run('bash', MERGE));
  writeFileSync(s.file, '{ "version": 1, "entries": [');
  waitsForOperator(await s.run('bash', MERGE));
}));

test("a checkout whose origin is the repository lifts its order for that repository from any folder, read from the checkout's own .git/config", () => withTempDir('optchat-order-lift-', async directory => {
  const checkout = join(directory, 'dentai-mono');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  writeFileSync(join(checkout, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/tecnologia-ai/dentai.git\n');
  const s = session(directory, QUOTES, { checkoutSlug });
  s.order({ ...ORDER, grant: { ...GRANT, scope: checkout } });
  assert.equal(await s.run('bash', 'gh pr merge 128 --repo tecnologia-ai/dentai --squash', 'C:/Users/swluc'), undefined, 'merged from another folder by slug');
  waitsForOperator(await s.run('bash', 'gh pr merge 129 --repo tecnologia-ai/other --squash', 'C:/Users/swluc'));
}));
