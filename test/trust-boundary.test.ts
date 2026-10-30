import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { classifyEffects, decide, parseContract, type Effect, type Repo } from '../src/autonomy.ts';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import { EffectApprovals } from '../src/authorization.ts';
import { forgetBrowserPages, observeBrowser, sensitivePage } from '../src/external-effects.ts';
import { ciProblem, directMerges, mergeRefusal, type Exec } from '../src/merge-ci-guard.ts';

// The operator's real incidents and the everyday calls that must stay frictionless, through the real gate.
const repo: Repo = { slug: () => 'lennix1337/pi-optchat', branch: () => 'feat/x' };
const call = (command: string, tool = 'bash') => ({ session: 'owner', cwd: 'C:/projetos/pi-optchat', tool, input: tool === 'codemode' ? { code: command } : { command } });
const lines = (found: Effect[]) => found.map(({ action, targets }) => [action, targets.join(',')].join(' '));
const kinds = (command: string) => lines(classifyEffects({ tool: 'bash', input: { command }, cwd: 'C:/projetos/pi-optchat' }, repo));
const riskOf = (gate: EffectApprovals, invocation: { session: string; cwd: string; tool: string; input: unknown }) => {
  const refusal = gate.admit(invocation);
  return refusal ? gate.pendingFor('owner').find(p => p.token === refusal.token)?.kind : undefined;
};

test('incidents: a real WhatsApp, a production HTTP write and an email are irreversible effects; reads of the same hosts are not', () => {
  assert.deepEqual(kinds(`curl -X POST https://graph.facebook.com/v19.0/1234/messages -H "Authorization: Bearer $T" -d '{"to":"5511"}'`), ['message graph.facebook.com']);
  assert.deepEqual(kinds('curl -s https://api.twilio.com/2010-04-01/Accounts/x/Messages.json --data-urlencode "Body=oi"'), ['message api.twilio.com']);
  assert.deepEqual(kinds('curl "https://api.telegram.org/bot123:abc/sendMessage?chat_id=1&text=oi"'), ['message api.telegram.org'], 'Telegram sends with a GET');
  assert.deepEqual(kinds('pwsh -Command "Send-MailMessage -To a@b.c -Subject x -SmtpServer s"'), ['message email']);
  assert.deepEqual(kinds('curl -X PATCH https://api.dentai.com.br/subscriptions/2cd5eaa6 --json \'{"plan":"br"}\''), ['production-write https:api.dentai.com.br']);
  assert.deepEqual(kinds('Invoke-RestMethod -Method Post -Uri https://usdentai.com/api/x -Body $b'), ['production-write https:usdentai.com']);
  assert.deepEqual(kinds('http POST api.dentai.com.br/leads name=x'), ['production-write https:api.dentai.com.br']);
  for (const read of ['curl -s https://api.dentai.com.br/health', 'curl -sI https://dentai.com.br/', 'curl -X GET https://api.dentai.com.br/plans',
    'curl -s https://graph.facebook.com/v19.0/me', 'wget -q https://dentai.com.br/robots.txt', 'Invoke-RestMethod https://api.dentai.com.br/health',
    'curl -X POST http://localhost:3000/api/x -d a=1', 'grep -rn "curl -X POST https://graph.facebook.com" docs'])
    assert.deepEqual(kinds(read), [], read);
});

test('without a rule of the operator, an irreversible effect asks; the default and the advisor no longer decide it', () => {
  const contract = parseContract({ version: 1, default: 'free', rules: [{ action: 'push', scope: ['*'], level: 'free' }] });
  for (const action of ['message', 'production-write', 'deploy', 'publish', 'force-push', 'consent', 'merge-bypass'] as const)
    assert.equal(decide(contract, [{ action, targets: ['x'] }]).level, 'ask', action);
  assert.equal(decide(contract, [{ action: 'merge', targets: ['x'] }]).level, 'free', 'a reversible effect follows the default');
  const allowed = parseContract({ version: 1, rules: [{ action: 'message', scope: ['email'], level: 'report' }] });
  assert.equal(decide(allowed, [{ action: 'message', targets: ['email'] }]).level, 'report', 'the operator can still write a rule for it');
});

test('the risk gate stops the incidents and lets everyday work through without asking', () => {
  const gate = new EffectApprovals({ mode: 'risk' });
  const stopped: [string, string][] = [
    ['ssh hetzner-dentai "docker exec db psql -c \\"UPDATE subscriptions SET plan_id=1\\""', 'production write'],
    ['curl -X POST https://graph.facebook.com/v19.0/1/messages -d x', 'third-party message'],
    ['curl -X DELETE https://api.dentai.com.br/users/1', 'production write'],
    ['gh pr merge 22 --admin --squash', 'merge bypassing CI'],
    ['pwsh -File scripts/release/deploy-changed.ps1', 'deploy'],
  ];
  for (const [command, kind] of stopped) assert.equal(riskOf(gate, call(command)), kind, command);
  assert.equal(riskOf(gate, call('await tools.bash({command:"curl -X POST https://api.sendgrid.com/v3/mail/send -d x"})', 'codemode')), 'third-party message');
  const everyday = ['git status', 'git commit -m "feat: x"', 'npm test', 'curl -s https://api.dentai.com.br/health', 'gh pr view 31 --json state',
    'gh pr create --fill', 'cat ~/.optchat/profiles/swlucas05/autonomy.json', 'rg -n autonomy src', 'gh run list --limit 5'];
  for (const command of everyday) assert.equal(gate.admit(call(command)), undefined, command);
  for (const tool of ['read', 'edit', 'write', 'zoom', 'ripwire', 'gitwatch']) assert.equal(gate.admit({ ...call(''), tool, input: { path: 'C:/projetos/pi-optchat/src/a.ts' } }), undefined, tool);
  // 87018/87019: a subagent task text that mentions autonomy.json is prose, not a contract change.
  assert.notEqual(riskOf(gate, { ...call(''), tool: 'spawn', input: { tasks: [{ task: 'fix the classifier; never touch autonomy.json' }] } }), 'autonomy contract change');
});

test('a click on a consent, account or billing page asks; browsing and other pages do not', () => {
  forgetBrowserPages();
  const gate = new EffectApprovals({ mode: 'risk' });
  const browser = (input: object) => ({ ...call(''), tool: 'browser_harness', input });
  observeBrowser({ action: 'open', url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' }, '{"status":"ok","tab":"T1"}');
  observeBrowser({ action: 'open', url: 'https://example.com/' }, '{"status":"ok","tab":"T2"}');
  assert.equal(riskOf(gate, browser({ action: 'click', tab: 'T1', node: 5 })), 'consent click');
  assert.equal(riskOf(gate, browser({ action: 'type', tab: 'T1', node: 5, text: 'x' })), 'consent click');
  assert.equal(riskOf(gate, browser({ action: 'evaluate', tab: 'T1', expression: 'document.querySelector("#allow").click()' })), 'consent click');
  assert.equal(gate.admit(browser({ action: 'evaluate', tab: 'T1', expression: 'document.title' })), undefined, 'reading the page is free');
  assert.equal(gate.admit(browser({ action: 'inspect', tab: 'T1' })), undefined);
  assert.equal(gate.admit(browser({ action: 'click', tab: 'T2', node: 5 })), undefined);
  // A click that lands on a consent page is caught on the next input: the result reports the page it is on now.
  observeBrowser({ action: 'click', tab: 'T2', node: 5 }, '{"status":"ok","tab":"T2","url":"https://console.cloud.google.com/billing/linkedaccount"}');
  assert.equal(riskOf(gate, browser({ action: 'click', tab: 'T2', node: 9 })), 'consent click');
  assert.deepEqual(classifyEffects({ tool: 'browser_harness', input: { action: 'click', tab: 'T2', node: 9 }, cwd: '.' }, repo), [{ action: 'consent', targets: ['console.cloud.google.com'] }]);
  observeBrowser({ action: 'close', tab: 'T2' }, '{"status":"ok"}');
  assert.equal(gate.admit(browser({ action: 'click', tab: 'T2', node: 9 })), undefined, 'a closed tab has no page');
  for (const page of ['https://github.com/settings/tokens', 'https://checkout.stripe.com/c/pay', 'https://www.paypal.com/x', 'https://pay.google.com/'])
    assert.equal(sensitivePage(page), true, page);
  for (const page of ['https://github.com/lennix1337/pi-optchat/pull/31', 'https://www.google.com/search?q=x', 'about:blank', 'https://mail.google.com/'])
    assert.equal(sensitivePage(page), false, page);
  forgetBrowserPages();
});

test('the registered gate sends an irreversible effect to the operator even when the advisor would approve it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trust-'));
  writeFileSync(join(dir, 'autonomy.json'), JSON.stringify({ version: 1, default: 'advisor', rules: [] }));
  const hooks = new Map<string, (...args: any[]) => any>();
  const asked: string[] = [];
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled: true, mode: 'risk', bell: () => {}, repo, contractDir: () => dir,
    advisor: async request => { asked.push(JSON.stringify(request.input)); return { approve: true, reason: 'fine', model: 'm' }; } });
  const ctx = { cwd: 'C:/projetos/pi-optchat', sessionManager: { getSessionId: () => 'owner', getBranch: () => [] }, ui: { notify: () => {}, setWidget: () => {} } };
  try {
    const sent = await hooks.get('tool_call')!({ toolName: 'bash', toolCallId: '1', input: { command: 'curl -X POST https://graph.facebook.com/v19.0/1/messages -d x' } }, ctx);
    assert.equal(sent?.block, true);
    assert.match(sent.reason, /message on graph\.facebook\.com: ask \(no matching rule\)/);
    assert.deepEqual(asked, []);
    const pushed = await hooks.get('tool_call')!({ toolName: 'bash', toolCallId: '2', input: { command: 'git push origin feat/x' } }, ctx);
    assert.equal(pushed, undefined, 'a branch push goes to the advisor, which approves');
    assert.equal(asked.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a merge runs only over green CI; --auto may wait only where GitHub itself waits for required checks', async () => {
  assert.deepEqual(directMerges('cd C:/projetos/x && gh pr merge 31 --squash --delete-branch', 'C:/'), [{ pr: '31', dir: 'C:/projetos/x' }]);
  assert.deepEqual(directMerges('gh pr merge --repo lennix1337/pi-optchat 31 -s', 'C:/projetos'), [{ pr: '31', repo: 'lennix1337/pi-optchat', dir: 'C:/projetos' }]);
  assert.deepEqual(directMerges('gh pr merge 3 --admin; gh pr view 31; gh pr merge --disable-auto 4', 'C:/'), []);
  assert.deepEqual(directMerges('gh pr merge 31 --auto --squash', 'C:/projetos'), [{ pr: '31', dir: 'C:/projetos', auto: true }]);
  const running = { statusCheckRollup: [{ name: 'unit', status: 'IN_PROGRESS' }] };
  assert.equal(ciProblem({ ...running, mergeStateStatus: 'BLOCKED' }, true), undefined, 'required checks: GitHub waits');
  // 2026-10-30, pi-browser-harness #1: no required checks, so --auto merged at once with CI still running.
  assert.match(ciProblem({ ...running, mergeStateStatus: 'CLEAN' }, true)!, /still running: unit/);
  assert.match(ciProblem({ ...running, mergeStateStatus: 'BLOCKED' })!, /still running/, 'a direct merge never waits');
  assert.equal(ciProblem({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' }], mergeStateStatus: 'CLEAN' }), undefined);
  assert.match(ciProblem({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] })!, /failing checks: unit/);
  assert.match(ciProblem({ statusCheckRollup: [{ name: 'windows', status: 'IN_PROGRESS' }] })!, /still running: windows/);
  assert.match(ciProblem({ statusCheckRollup: [{ context: 'ci/legacy', state: 'FAILURE' }] })!, /failing checks: ci\/legacy/);
  assert.equal(ciProblem({ statusCheckRollup: [] }), undefined, 'a repository without CI merges');
  const calls: string[][] = [];
  const exec = (view: object | Error): Exec => async (_c, args) => { calls.push(args); if (view instanceof Error) throw view; return { code: 0, stdout: JSON.stringify(view), stderr: '' }; };
  assert.match((await mergeRefusal('gh pr merge 31 --squash', 'C:/', exec({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] })))!, /Not run: PR 31 .*failing checks: unit/);
  assert.match((await mergeRefusal('gh pr merge 31 --auto --squash', 'C:/', exec({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }], mergeStateStatus: 'BLOCKED' })))!, /failing checks/, 'red CI stops --auto too');
  assert.deepEqual(calls.at(-1), ['pr', 'view', '31', '--json', 'statusCheckRollup,mergeStateStatus']);
  assert.equal(await mergeRefusal('gh pr merge 31 --squash', 'C:/', exec({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }] })), undefined);
  assert.match((await mergeRefusal('gh pr merge 31', 'C:/', exec(new Error('gh not found'))))!, /could not read its checks/, 'unknown CI is not green CI');
  assert.equal(await mergeRefusal('gh pr merge 31 --auto --squash', 'C:/', exec({ ...running, mergeStateStatus: 'BLOCKED' })), undefined);
});
