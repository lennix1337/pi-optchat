import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { classifyEffects, decide, gitRepo, parseContract, type Effect, type Repo } from '../src/autonomy.ts';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import { EffectApprovals } from '../src/authorization.ts';
import { forgetBrowserPages, observeBrowser, sensitivePage, withProductionHosts } from '../src/external-effects.ts';
import { ciProblem, directMerges, mergeRefusal, openMajors, type Exec } from '../src/merge-ci-guard.ts';
import { reviewBody } from '../scripts/ship-review.mjs';


const repo: Repo = { slug: () => 'lennix1337/pi-optchat', branch: () => 'feat/x' };
const call = (command: string, tool = 'bash') => ({ session: 'owner', cwd: 'C:/projetos/pi-optchat', tool, input: tool === 'codemode' ? { code: command } : { command } });
const lines = (found: Effect[]) => found.map(({ action, targets }) => [action, targets.join(',')].join(' '));
const productionHosts = ['dentai.com.br', 'usdentai.com', 'api.stripe.com'];
const classified = (call: Parameters<typeof classifyEffects>[0], source = repo) => withProductionHosts(productionHosts, () => lines(classifyEffects(call, source)));
const kinds = (command: string) => classified({ tool: 'bash', input: { command }, cwd: 'C:/projetos/pi-optchat' });
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

  for (const write of ['curl -X POST https://api.dentai.com.br/jobs/run -H "Authorization: Bearer $T"', 'curl -X POST -u admin:x https://api.dentai.com.br/x',
    'curl -X POST -b session=1 https://api.dentai.com.br/x', 'curl -X POST https://api.dentai.com.br/x -H "Stripe-Signature: t=1"',
    'curl -X PUT https://api.dentai.com.br/x', 'Invoke-RestMethod -Method Post -Uri https://api.dentai.com.br/x -Headers $h'])
    assert.deepEqual(kinds(write), ['production-write https:api.dentai.com.br'], write);
  for (const read of ['curl -s https://api.dentai.com.br/health', 'curl -sI https://dentai.com.br/', 'curl -X GET https://api.dentai.com.br/plans',
    'curl -s https://graph.facebook.com/v19.0/me', 'wget -q https://dentai.com.br/robots.txt', 'Invoke-RestMethod https://api.dentai.com.br/health',
    'curl -X POST http://localhost:3000/api/x -d a=1',

    'curl -s -i -m 20 -X POST https://api.dentai.com.br/webhooks/stripe', 'curl -X POST https://api.github.com/x -H "Accept: application/json"', 'Invoke-WebRequest -Method Post -Uri https://usdentai.com/api/hook', 'grep -rn "curl -X POST https://graph.facebook.com" docs'])
    assert.deepEqual(kinds(read), [], read);
});

test('incidents 05/11: a page script that writes to production and a Stripe API write are production writes; their reads are not', () => {
  forgetBrowserPages();

  const pagePut = `node brave-dentai.mjs eval $T "(async()=>{const fd=new FormData();const r=await fetch('https://api.dentai.com.br/attract/admin/suppliers/cd0d87f8/html',{method:'PUT',credentials:'include',body:fd});return r.status})()"`;
  assert.deepEqual(kinds(pagePut), ['production-write https:api.dentai.com.br']);
  assert.deepEqual(kinds(pagePut.replaceAll("'", '\\"')), ['production-write https:api.dentai.com.br'], 'escaped quotes inside the shell string');
  assert.deepEqual(kinds(`node x.mjs eval $T "axios.delete('https://usdentai.com/api/users/1')"`), ['production-write https:usdentai.com']);
  assert.deepEqual(kinds(`node x.mjs eval $T "const x=new XMLHttpRequest();x.open('POST','https://api.dentai.com.br/leads');x.send(b)"`), ['production-write https:api.dentai.com.br']);
  const browser = (expression: string, tab = 'P1') => classified({ tool: 'browser_harness', input: { action: 'evaluate', tab, expression }, cwd: '' });
  observeBrowser({ action: 'open', url: 'https://dentai.com.br/admin' }, '{"status":"ok","tab":"P1"}');
  observeBrowser({ action: 'open', url: 'http://localhost:3000/' }, '{"status":"ok","tab":"L1"}');
  assert.deepEqual(browser("fetch('https://api.dentai.com.br/x',{method:'PATCH',body:b})"), ['production-write https:api.dentai.com.br']);
  assert.deepEqual(browser("fetch('/api/suppliers/1',{method:'DELETE'})"), ['production-write https:dentai.com.br'], 'a relative URL resolves against the tab page');

  assert.deepEqual(kinds('curl -s https://api.stripe.com/v1/account -u "$K:" -d "business_profile[support_email]=contato@dentai.com.br"'), ['production-write https:api.stripe.com']);
  for (const read of ["fetch('https://api.dentai.com.br/health')", "fetch('https://api.dentai.com.br/x',{method:'GET'})", "fetch('/api/x',{method:'POST'})"])
    assert.deepEqual(browser(read, read.startsWith("fetch('/") ? 'L1' : 'P1'), [], read);
  for (const read of ['curl -s https://api.stripe.com/v1/account -u "$K:"', `node x.mjs eval $T "fetch('https://dentai.com.br/robots.txt').then(r=>r.text())"`,
    `node x.mjs eval $T "fetch('http://localhost:3000/api/x',{method:'POST'})"`])
    assert.deepEqual(kinds(read), [], read);
});

test('incident 06/11: a script file that submits a form on a production page, or writes to production, is a production write', () => {
  forgetBrowserPages();

  const cdp = "const ws = new WebSocket(tab.webSocketDebuggerUrl);\nawait send('Runtime.evaluate', { expression: `document.getElementById('sim-nome').value = 'Teste'; f.requestSubmit()` });";
  const scripts: Record<string, string> = {
    '/tmp/odo-e2e.mjs': cdp,
    '/tmp/odo-url.mjs': `${cdp}\nconst origin = 'https://dentai.com.br';`,
    '/tmp/lead.mjs': "await fetch('https://api.dentai.com.br/leads', { method: 'POST', body })",
    '/tmp/read.mjs': "const r = await fetch('https://api.dentai.com.br/health'); console.log(await r.text())",
    '/tmp/local.mjs': `${cdp}\nconst page = 'http://localhost:3100/sample-clinic';`,
  };
  const scriptRepo: Repo = { ...repo, script: path => scripts[path] };
  const run = (command: string) => classified({ tool: 'bash', input: { command }, cwd: 'C:/projetos/pi-optchat' }, scriptRepo);
  observeBrowser({ action: 'navigate', tab: 'B28A5503AB0400E9C87DA330EFA164E1', url: 'https://dentai.com.br/sample-clinic' }, '{"status":"ok"}');
  observeBrowser({ action: 'open', url: 'http://localhost:3100/' }, '{"status":"ok","tab":"LOCAL0001"}');
  assert.deepEqual(run('sleep 3; cd /tmp && timeout 60 node odo-e2e.mjs B28A5503AB0400E9C87DA330EFA164E1; echo rc=$?'), ['production-write https:dentai.com.br'], 'the owned tab it drives is on production');
  assert.deepEqual(run('node /tmp/odo-e2e.mjs B28A5503'), ['production-write https:dentai.com.br'], 'a tab id prefix names the same tab');
  assert.deepEqual(run('node /tmp/odo-url.mjs'), ['production-write https:dentai.com.br'], 'the script names the production page itself');
  assert.deepEqual(run('node /tmp/lead.mjs'), ['production-write https:api.dentai.com.br'], 'a fetch write in the file');
  for (const free of ['node /tmp/read.mjs', 'node /tmp/local.mjs LOCAL0001', 'node /tmp/odo-e2e.mjs LOCAL0001', 'node --test /tmp/odo-url.mjs', 'node /tmp/missing.mjs'])
    assert.deepEqual(run(free), [], free);
  forgetBrowserPages();
});

test('a Git Bash /tmp script is read from the temp folder it names', () => {
  const name = `pi-optchat-script-${process.pid}.mjs`;
  writeFileSync(join(tmpdir(), name), 'console.log(1)');
  try { assert.equal(gitRepo.script!(`/tmp/${name}`), 'console.log(1)'); }
  finally { rmSync(join(tmpdir(), name), { force: true }); }
});

test('without a rule of the operator, an irreversible effect asks; the default does not decide it', () => {
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
    'gh pr create --fill', 'cat ~/.optchat/profiles/sample-profile/autonomy.json', 'rg -n autonomy src', 'gh run list --limit 5'];
  for (const command of everyday) assert.equal(gate.admit(call(command)), undefined, command);
  for (const tool of ['read', 'edit', 'write', 'zoom', 'ripwire', 'gitwatch']) assert.equal(gate.admit({ ...call(''), tool, input: { path: 'C:/projetos/pi-optchat/src/a.ts' } }), undefined, tool);

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

// external: browser_harness v2 exec runs Python cells whose helpers operate on the same tab.
test('an exec cell with input on a consent, account or billing page asks; reading cells and other pages do not', () => {
  forgetBrowserPages();
  const gate = new EffectApprovals({ mode: 'risk' });
  const exec = (code: unknown, tab = 'T1') => ({ ...call(''), tool: 'browser_harness', input: { action: 'exec', tab, code } });
  observeBrowser({ action: 'open', url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' }, '{"status":"ok","tab":"T1"}');
  observeBrowser({ action: 'open', url: 'https://example.com/' }, '{"status":"ok","tab":"T2"}');
  const inputs = ['click(5)', 'type(5, "x")', 'type(id=5, text="x")', "press('Enter')", "upload(3, 'C:/tmp/a.pdf')", 'dialog(accept=True)', 'dialog(True)',
    'for i in range(3):\n    click(i)', "js('document.querySelector(\"#allow\").click()')", 'js("form.requestSubmit()")'];
  for (const code of inputs) assert.equal(riskOf(gate, exec(code)), 'consent click', code);
  const reads = ['state()', 'screenshot()', "js('document.title')", 'scroll(0, 500)', 'dialog()', 'dialog(accept=False)', 'print(type(x))', 'x = wait_for_network_idle()', 'network({"url": "api"})'];
  for (const code of reads) assert.equal(gate.admit(exec(code)), undefined, code);
  for (const code of inputs) assert.equal(gate.admit(exec(code, 'T2')), undefined, `${code} on an ordinary page`);
  assert.equal(gate.admit(exec('click(5)', 'unknown')), undefined, 'an unknown tab has no page');
  assert.equal(gate.admit(exec(null)), undefined, 'no code, no input');
  assert.equal(gate.admit(exec(5)), undefined, 'code that is not text has no input');
  assert.deepEqual(classifyEffects({ tool: 'browser_harness', input: { action: 'exec', tab: 'T1', code: 'click(5)' }, cwd: '.' }, repo), [{ action: 'consent', targets: ['accounts.google.com'] }]);

  assert.equal(riskOf(gate, exec("goto('https://checkout.stripe.com/c/pay')\nclick(1)", 'T2')), 'consent click');
  assert.equal(gate.admit(exec("goto('https://example.org/')\nclick(1)", 'T2')), undefined);
  assert.equal(gate.admit(exec("goto('https://checkout.stripe.com/c/pay')\nstate()", 'T2')), undefined, 'looking is not consenting');

  assert.equal(riskOf(gate, { ...call(''), tool: 'browser_harness', input: { action: 'click', tab: 'T1', node: 5 } }), 'consent click');
  assert.equal(gate.admit({ ...call(''), tool: 'browser_harness', input: { action: 'evaluate', tab: 'T1', expression: 'document.title', code: 'click(5)' } }), undefined);
  assert.equal(gate.admit({ ...call(''), tool: 'browser_harness', input: { action: 'inspect', tab: 'T1', code: 'click(5)' } }), undefined);
  assert.equal(gate.admit({ ...call(''), tool: 'browser_harness', input: { action: 'state', tab: 'T1', code: 'click(5)' } }), undefined);
  forgetBrowserPages();
});

test('a fetch or XHR written inside an exec cell is a production write like the same text in evaluate', () => {
  forgetBrowserPages();
  const cell = (code: string, tab = 'P1') => classified({ tool: 'browser_harness', input: { action: 'exec', tab, code }, cwd: '' });
  observeBrowser({ action: 'open', url: 'https://dentai.com.br/admin' }, '{"status":"ok","tab":"P1"}');
  observeBrowser({ action: 'open', url: 'http://localhost:3000/' }, '{"status":"ok","tab":"L1"}');
  assert.deepEqual(cell("js(\"fetch('https://api.dentai.com.br/x',{method:'PATCH',body:b})\")"), ['production-write https:api.dentai.com.br']);
  assert.deepEqual(cell("r = js('fetch(\\'/api/suppliers/1\\',{method:\"DELETE\"})')"), ['production-write https:dentai.com.br'], 'a relative URL resolves against the tab page');
  assert.deepEqual(cell('js("axios.delete(\'https://usdentai.com/api/users/1\')")'), ['production-write https:usdentai.com']);
  assert.deepEqual(cell('js("fetch(\'https://graph.facebook.com/v19.0/1/messages\',{method:\'POST\',body:b})")'), ['message graph.facebook.com']);

  assert.deepEqual(cell("goto('https://usdentai.com/app')\njs(\"fetch('/api/x',{method:'PUT'})\")", 'L1'), ['production-write https:usdentai.com']);
  for (const read of ["js(\"fetch('https://api.dentai.com.br/health')\")", "js(\"fetch('https://api.dentai.com.br/x',{method:'GET'})\")", 'state()', 'click(3)'])
    assert.deepEqual(cell(read), [], read);
  assert.deepEqual(cell("js(\"fetch('/api/x',{method:'POST'})\")", 'L1'), [], 'a local page is not production');

  assert.deepEqual(lines(classifyEffects({ tool: 'browser_harness', input: { action: 'evaluate', tab: 'P1', code: "js(\"fetch('https://api.dentai.com.br/x',{method:'PATCH'})\")" }, cwd: '' }, repo)), []);
  forgetBrowserPages();
});

test('exec and state results move a tab to the page their header reports; goto fills in when the header has none', () => {
  forgetBrowserPages();
  const consent = (tab: string) => lines(classifyEffects({ tool: 'browser_harness', input: { action: 'exec', tab, code: 'click(1)' }, cwd: '' }, repo));
  observeBrowser({ action: 'open', url: 'https://example.com/' }, '{"status":"ok","tab":"T1"}');
  assert.deepEqual(consent('T1'), []);

  observeBrowser({ action: 'exec', tab: 'T1', code: 'goto(url)' }, '{"status":"ok","tab":"T1","url":"https://pay.google.com/"}\n{"ok":true}');
  assert.deepEqual(consent('T1'), ['consent pay.google.com']);
  observeBrowser({ action: 'state', tab: 'T1' }, '{"status":"ok","tab":"T1","url":"https://example.com/back"}\n[]');
  assert.deepEqual(consent('T1'), [], 'state reports the page too');

  observeBrowser({ action: 'exec', tab: 'T1', code: 'print(js("JSON.stringify(location)"))' }, '{"status":"ok","tab":"T1","url":"https://example.com/back"}\n{"url":"https://pay.google.com/"}');
  assert.deepEqual(consent('T1'), []);
  observeBrowser({ action: 'exec', tab: 'T1', code: 'x' }, 'not a header\n{"tab":"T1","url":"https://pay.google.com/"}');
  assert.deepEqual(consent('T1'), [], 'no header, no move');

  observeBrowser({ action: 'exec', tab: 'T1', code: "goto('https://example.org/a')\ngoto('https://checkout.stripe.com/c/pay')" }, '{"status":"error","tab":"T1"}');
  assert.deepEqual(consent('T1'), ['consent checkout.stripe.com']);
  observeBrowser({ action: 'exec', tab: 'T1', code: "goto('https://example.org/a')" }, '{"status":"ok","tab":"T1","url":"https://example.com/"}');
  assert.deepEqual(consent('T1'), [], 'the header wins over the goto text');

  observeBrowser({ action: 'exec', tab: 'T1', code: 'goto(target)' }, '{"status":"error","tab":"T1"}');
  assert.deepEqual(consent('T1'), []);
  observeBrowser({ action: 'state', tab: 'T1' }, '{"status":"ok","tab":"T1","url":"https://example.com/back"}\n[{"url":"https://pay.google.com/"}]');
  assert.deepEqual(consent('T1'), [], 'a url in the state body is not the tab address');
  observeBrowser({ action: 'state', tab: 'T1' }, '{"status":"ok","tab":"T1"}\n[{"url":"https://pay.google.com/"}]');
  assert.deepEqual(consent('T1'), [], 'no url in the header, no move');
  observeBrowser({ action: 'exec', code: 'x' }, '{"status":"ok","url":"https://pay.google.com/"}\n{"tab":"T9"}');
  assert.deepEqual(consent('T9'), [], 'a tab named only by the cell output is not the header');

  observeBrowser({ action: 'exec', code: 'x' }, '{"status":"ok","tab":"T3","url":"https://github.com/settings/tokens"}');
  assert.deepEqual(consent('T3'), ['consent github.com']);

  observeBrowser({ action: 'click', tab: 'T1', node: 5 }, 'clicked\n{"tab":"T1","url":"https://pay.google.com/"}');
  assert.deepEqual(consent('T1'), ['consent pay.google.com']);
  forgetBrowserPages();
});

test('the registered gate sends an irreversible effect with no rule to the operator and lets a branch push run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trust-'));
  writeFileSync(join(dir, 'autonomy.json'), JSON.stringify({ version: 1, default: 'report', rules: [] }));
  const hooks = new Map<string, (...args: any[]) => any>();
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled: true, mode: 'risk', bell: () => {}, repo, contractDir: () => dir });
  const ctx = { cwd: 'C:/projetos/pi-optchat', sessionManager: { getSessionId: () => 'owner', getBranch: () => [] }, ui: { notify: () => {}, setWidget: () => {} } };
  try {
    const sent = await hooks.get('tool_call')!({ toolName: 'bash', toolCallId: '1', input: { command: 'curl -X POST https://graph.facebook.com/v19.0/1/messages -d x' } }, ctx);
    assert.equal(sent?.block, true);
    assert.match(sent.reason, /message on graph\.facebook\.com: ask \(no matching rule\)/);
    const pushed = await hooks.get('tool_call')!({ toolName: 'bash', toolCallId: '2', input: { command: 'git push origin feat/x' } }, ctx);
    assert.equal(pushed, undefined, 'a branch push has no rule: it runs and is logged');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a merge runs only over green CI; --auto may wait only where GitHub itself waits for required checks', async () => {
  assert.deepEqual(directMerges('cd C:/projetos/x && gh pr merge 31 --squash --delete-branch', 'C:/'), [{ pr: '31', dir: 'C:/projetos/x' }]);
  assert.deepEqual(directMerges('gh pr merge --repo lennix1337/pi-optchat 31 -s', 'C:/projetos'), [{ pr: '31', repo: 'lennix1337/pi-optchat', dir: 'C:/projetos' }]);
  assert.deepEqual(directMerges('gh pr merge 3 --admin; gh pr view 31; gh pr merge --disable-auto 4', 'C:/'), []);
  assert.deepEqual(directMerges('gh pr merge 31 --auto --squash', 'C:/projetos'), [{ pr: '31', dir: 'C:/projetos', auto: true }]);
  const running = { statusCheckRollup: [{ name: 'unit', status: 'IN_PROGRESS' }] };
  assert.equal(ciProblem({ ...running, mergeStateStatus: 'BLOCKED' }, true), undefined, 'required checks: GitHub waits');
  // external: GitHub can immediately merge with --auto when no checks are required.
  assert.match(ciProblem({ ...running, mergeStateStatus: 'CLEAN' }, true)!, /still running: unit/);
  assert.match(ciProblem({ ...running, mergeStateStatus: 'BLOCKED' })!, /still running/, 'a direct merge never waits');
  assert.equal(ciProblem({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' }], mergeStateStatus: 'CLEAN' }), undefined);
  assert.match(ciProblem({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] })!, /failing checks: unit/);
  assert.match(ciProblem({ statusCheckRollup: [{ name: 'windows', status: 'IN_PROGRESS' }] })!, /still running: windows/);
  assert.match(ciProblem({ statusCheckRollup: [{ context: 'ci/legacy', state: 'FAILURE' }] })!, /failing checks: ci\/legacy/);

  assert.match(ciProblem({ statusCheckRollup: [] })!, /no CI check/, 'a PR without any check tested nothing');
  const calls: string[][] = [];
  const exec = (view: object | Error): Exec => async (_c, args) => { calls.push(args); if (view instanceof Error) throw view; return { code: 0, stdout: JSON.stringify(view), stderr: '' }; };
  assert.match((await mergeRefusal('gh pr merge 31 --squash', 'C:/', exec({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }] })))!, /Not run: PR 31 .*failing checks: unit/);
  assert.match((await mergeRefusal('gh pr merge 31 --auto --squash', 'C:/', exec({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }], mergeStateStatus: 'BLOCKED' })))!, /failing checks/, 'red CI stops --auto too');
  assert.deepEqual(calls.at(-1), ['pr', 'view', '31', '--json', 'statusCheckRollup,mergeStateStatus,headRefOid,headRepository,body']);
  assert.equal(await mergeRefusal('gh pr merge 31 --squash', 'C:/', exec({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }] })), undefined);
  assert.match((await mergeRefusal('gh pr merge 31', 'C:/', exec(new Error('gh not found'))))!, /could not read its checks/, 'unknown CI is not green CI');
  assert.equal(await mergeRefusal('gh pr merge 31 --auto --squash', 'C:/', exec({ ...running, mergeStateStatus: 'BLOCKED' })), undefined);
});

test('a merge waits while the Revisor block in the PR description lists an open major finding (#601, #602 and dotfiles #226 merged past them)', async () => {
  const block = (lines: string) => `Problema: x\n\n<!-- ship:revisor:start -->\n## Revisor\n\n${lines}\n<!-- ship:revisor:end -->\n`;
  const major = block('- [model_review:major] src/ideas.ts:107: O catch engole linhas. → Revise.\n- [model_review:minor] src/ideas.ts:108: valide. → Revise.');
  assert.deepEqual(openMajors(major), ['src/ideas.ts:107']);
  assert.deepEqual(openMajors(block('- [model_review:minor] a.ts:1: nada grave.')), []);
  assert.deepEqual(openMajors('- [model_review:major] fora do bloco do Revisor'), []);
  const written = reviewBody('Problema: x', { verdict: 'changes', findings: [
    { severity: 'major', file: 'src/a.ts', line: 3, text: 'grave.' }, { severity: 'blocker', file: 'src/b.ts', text: 'sem linha.' },
    { code: 'cr', severity: 'major', text: 'sem arquivo.' }, { severity: 'minor', file: 'c.ts', line: 1, text: 'como [o major] disse, nada grave.' }] });
  assert.deepEqual(openMajors(written), ['src/a.ts:3', 'src/b.ts', 'sem local'], 'parses what ship-review.mjs writes, majors and blockers only');
  assert.deepEqual(openMajors(reviewBody('x', { verdict: 'changes', findings: [] })), ['sem local'], 'changes without detail stay open');
  assert.deepEqual(openMajors(reviewBody('x', { verdict: 'approve', findings: [{ severity: 'minor', file: 'd.ts', line: 2, text: '[no major issues] ok.' }] })), [], 'a severity named in prose is not a finding');
  assert.deepEqual(openMajors(null), []);
  assert.match((await mergeRefusal('gh pr merge 602 --squash', 'C:/', async () => ({ code: 1, stdout: '', stderr: 'HTTP 502' })))!, /could not read its checks/, 'an unreadable description never lets the merge through');
  assert.match((await mergeRefusal('gh pr merge 602 --squash', 'C:/', async () => ({ code: 0, stdout: '{not json', stderr: '' })))!, /could not read its checks/);
  const green = { statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }], mergeStateStatus: 'CLEAN' };
  const exec = (body: string): Exec => async () => ({ code: 0, stdout: JSON.stringify({ ...green, body }), stderr: '' });
  for (const command of ['gh pr merge 602 --squash', 'gh pr merge 602 --auto --squash'])
    assert.match((await mergeRefusal(command, 'C:/', exec(major)))!, /^Not run: PR 602 still has open major findings from the Revisor \(src\/ideas\.ts:107\).*ship\.mjs --pr 602/);
  assert.equal(await mergeRefusal('gh pr merge 602 --squash', 'C:/', exec(block('- [model_review:minor] a.ts:1: ok.'))), undefined);
});

test('a merge the guard cannot check before it runs is refused with the way through: a PR in a shell variable, a PR the same command creates', async () => {
  const calls: string[][] = [];
  const noPr: Exec = async (_c, args) => { calls.push(args); return { code: 1, stdout: '', stderr: 'no pull requests found for branch "docs/ci-runners"' }; };

  const loop = await mergeRefusal('for n in 976 977; do gh pr merge $n -R lennix1337/Genexus18MCP --squash --auto; done', 'C:/', noPr);
  assert.match(loop!, /^Not run: .*shell variable \(\$n\).*one `gh pr merge <N>` per PR/);
  const repo = await mergeRefusal('for r in pi-lsp:3; do gh pr merge 3 -R lennix1337/$p --squash; done', 'C:/', noPr);
  assert.match(repo!, /shell variable \(lennix1337\/\$p\)/);
  assert.equal(calls.length, 0, 'nothing to look up');
  const created = await mergeRefusal('git push -u origin docs/ci-runners && gh pr create --fill && gh pr merge --auto --squash', 'C:/', noPr);
  assert.match(created!, /^Not run: .*does not exist yet.*separate call.*ship\.mjs/);
  assert.doesNotMatch(created!, /Wait for the checks/);
});

test('a red check whose Actions job never ran a step (GitHub refused to start it: billing) does not block a merge once the head passed local verification; a job that ran steps does', async t => {
  const sha = '6b02a198341438d5e800cbfdcce9de7874e47d0d';
  const receipts = mkdtempSync(join(tmpdir(), 'local-verify-'));
  const previous = process.env.PI_LOCAL_VERIFY_DIR;
  process.env.PI_LOCAL_VERIFY_DIR = receipts;
  t.after(() => { rmSync(receipts, { recursive: true, force: true }); if (previous === undefined) delete process.env.PI_LOCAL_VERIFY_DIR; else process.env.PI_LOCAL_VERIFY_DIR = previous; });
  const neverRan = { statusCheckRollup: [
    { name: 'changes', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/lennix1337/dotfiles/actions/runs/1/job/11' },
    { name: 'instruction-guard', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/lennix1337/dotfiles/actions/runs/1/job/12' },
    { name: 'offline-suites', status: 'COMPLETED', conclusion: 'SKIPPED' }], mergeStateStatus: 'UNSTABLE', headRefOid: sha, headRepository: { name: 'dotfiles' } };
  const gh = (view: object, steps: Record<string, string>): Exec => async (_c, args) =>
    args[0] === 'api' ? { code: 0, stdout: steps[args[1]!] ?? '', stderr: '' } : { code: 0, stdout: JSON.stringify(view), stderr: '' };
  const zero = { 'repos/lennix1337/dotfiles/actions/jobs/11': '0', 'repos/lennix1337/dotfiles/actions/jobs/12': '0' };
  assert.match((await mergeRefusal('gh pr merge 78 --squash', 'C:/', gh(neverRan, zero)))!, /never started \(billing\) and no local verification receipt exists for head 6b02a198.*local-verify\.mjs/, 'CI that never ran tested nothing: the local verification must stand in');
  const noChecks = { statusCheckRollup: [], mergeStateStatus: 'CLEAN', headRefOid: sha };
  assert.match((await mergeRefusal('gh pr merge 5 --squash', 'C:/', gh(noChecks, {})))!, /no CI check.*no local verification receipt exists for head 6b02a198.*local-verify\.mjs/, 'a PR with no check at all needs the local verification too');
  assert.match((await mergeRefusal('gh pr merge 5 --auto --squash', 'C:/', gh(noChecks, {})))!, /no CI check/, 'without required checks GitHub merges --auto at once');
  writeFileSync(join(receipts, `${sha}.json`), '{}');
  assert.equal(await mergeRefusal('gh pr merge 78 --squash', 'C:/', gh(neverRan, zero)), undefined, 'no step ran in any red job and the head passed local verification');
  assert.equal(await mergeRefusal('gh pr merge 5 --squash', 'C:/', gh(noChecks, {})), undefined, 'no CI, but the head passed local verification');
  assert.match((await mergeRefusal('gh pr merge 78 --squash', 'C:/', gh(neverRan, { ...zero, 'repos/lennix1337/dotfiles/actions/jobs/12': '4' })))!, /failing checks/, 'a job that ran steps failed for real');
  assert.match((await mergeRefusal('gh pr merge 78 --squash', 'C:/', gh(neverRan, {})))!, /failing checks/, 'steps that cannot be read are not proof');
  const legacy = { ...neverRan, statusCheckRollup: [{ context: 'ci/legacy', state: 'FAILURE' }] };
  assert.match((await mergeRefusal('gh pr merge 78 --squash', 'C:/', gh(legacy, zero)))!, /failing checks: ci\/legacy/, 'a status without an Actions job is not covered');
  const inFlight = { ...neverRan, statusCheckRollup: [...neverRan.statusCheckRollup, { name: 'windows', status: 'IN_PROGRESS', conclusion: '' }] };
  assert.match((await mergeRefusal('gh pr merge 78 --squash', 'C:/', gh(inFlight, zero)))!, /retry the same merge in a few seconds; never `--admin`/, 'a red job beside a running one says to wait, not to bypass');
});
