import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { classifyEffects, decide, gitRepo, parseContract, type Effect, type Repo } from '../src/autonomy.ts';
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
  // With a credential, a body, or a destructive verb, an empty request is no longer anonymous probing.
  for (const write of ['curl -X POST https://api.dentai.com.br/jobs/run -H "Authorization: Bearer $T"', 'curl -X POST -u admin:x https://api.dentai.com.br/x',
    'curl -X POST -b session=1 https://api.dentai.com.br/x', 'curl -X POST https://api.dentai.com.br/x -H "Stripe-Signature: t=1"',
    'curl -X PUT https://api.dentai.com.br/x', 'Invoke-RestMethod -Method Post -Uri https://api.dentai.com.br/x -Headers $h'])
    assert.deepEqual(kinds(write), ['production-write https:api.dentai.com.br'], write);
  for (const read of ['curl -s https://api.dentai.com.br/health', 'curl -sI https://dentai.com.br/', 'curl -X GET https://api.dentai.com.br/plans',
    'curl -s https://graph.facebook.com/v19.0/me', 'wget -q https://dentai.com.br/robots.txt', 'Invoke-RestMethod https://api.dentai.com.br/health',
    'curl -X POST http://localhost:3000/api/x -d a=1',
    // An anonymous, empty POST does only what any stranger on the internet can: a probe (webhook signature check, endpoint up).
    'curl -s -i -m 20 -X POST https://api.dentai.com.br/webhooks/stripe', 'curl -X POST https://api.github.com/x -H "Accept: application/json"', 'Invoke-WebRequest -Method Post -Uri https://usdentai.com/api/hook', 'grep -rn "curl -X POST https://graph.facebook.com" docs'])
    assert.deepEqual(kinds(read), [], read);
});

test('incidents 05/11: a page script that writes to production and a Stripe API write are production writes; their reads are not', () => {
  forgetBrowserPages();
  // 116952: the Odontoclinic landing re-uploaded to production from a page script run through a browser helper.
  const pagePut = `node brave-dentai.mjs eval $T "(async()=>{const fd=new FormData();const r=await fetch('https://api.dentai.com.br/attract/admin/suppliers/cd0d87f8/html',{method:'PUT',credentials:'include',body:fd});return r.status})()"`;
  assert.deepEqual(kinds(pagePut), ['production-write https:api.dentai.com.br']);
  assert.deepEqual(kinds(pagePut.replaceAll("'", '\\"')), ['production-write https:api.dentai.com.br'], 'escaped quotes inside the shell string');
  assert.deepEqual(kinds(`node x.mjs eval $T "axios.delete('https://usdentai.com/api/users/1')"`), ['production-write https:usdentai.com']);
  assert.deepEqual(kinds(`node x.mjs eval $T "const x=new XMLHttpRequest();x.open('POST','https://api.dentai.com.br/leads');x.send(b)"`), ['production-write https:api.dentai.com.br']);
  const browser = (expression: string, tab = 'P1') => lines(classifyEffects({ tool: 'browser_harness', input: { action: 'evaluate', tab, expression }, cwd: '' }, repo));
  observeBrowser({ action: 'open', url: 'https://dentai.com.br/admin' }, '{"status":"ok","tab":"P1"}');
  observeBrowser({ action: 'open', url: 'http://localhost:3000/' }, '{"status":"ok","tab":"L1"}');
  assert.deepEqual(browser("fetch('https://api.dentai.com.br/x',{method:'PATCH',body:b})"), ['production-write https:api.dentai.com.br']);
  assert.deepEqual(browser("fetch('/api/suppliers/1',{method:'DELETE'})"), ['production-write https:dentai.com.br'], 'a relative URL resolves against the tab page');
  // 116829: a write through the Stripe API with the operator's key changes his live account.
  assert.deepEqual(kinds('curl -s https://api.stripe.com/v1/account -u "$K:" -d "business_profile[support_email]=contato@dentai.com.br"'), ['production-write https:api.stripe.com']);
  for (const read of ["fetch('https://api.dentai.com.br/health')", "fetch('https://api.dentai.com.br/x',{method:'GET'})", "fetch('/api/x',{method:'POST'})"])
    assert.deepEqual(browser(read, read.startsWith("fetch('/") ? 'L1' : 'P1'), [], read);
  for (const read of ['curl -s https://api.stripe.com/v1/account -u "$K:"', `node x.mjs eval $T "fetch('https://dentai.com.br/robots.txt').then(r=>r.text())"`,
    `node x.mjs eval $T "fetch('http://localhost:3000/api/x',{method:'POST'})"`])
    assert.deepEqual(kinds(read), [], read);
});

test('incident 06/11: a script file that submits a form on a production page, or writes to production, is a production write', () => {
  forgetBrowserPages();
  // 128900: a CDP script in the temp folder filled and submitted the live Odontoclinic form (a fake lead) on an owned tab.
  const cdp = "const ws = new WebSocket(tab.webSocketDebuggerUrl);\nawait send('Runtime.evaluate', { expression: `document.getElementById('sim-nome').value = 'Teste'; f.requestSubmit()` });";
  const scripts: Record<string, string> = {
    '/tmp/odo-e2e.mjs': cdp,
    '/tmp/odo-url.mjs': `${cdp}\nconst origin = 'https://dentai.com.br';`,
    '/tmp/lead.mjs': "await fetch('https://api.dentai.com.br/leads', { method: 'POST', body })",
    '/tmp/read.mjs': "const r = await fetch('https://api.dentai.com.br/health'); console.log(await r.text())",
    '/tmp/local.mjs': `${cdp}\nconst page = 'http://localhost:3100/odontoclinic';`,
  };
  const scriptRepo: Repo = { ...repo, script: path => scripts[path] };
  const run = (command: string) => lines(classifyEffects({ tool: 'bash', input: { command }, cwd: 'C:/projetos/pi-optchat' }, scriptRepo));
  observeBrowser({ action: 'navigate', tab: 'B28A5503AB0400E9C87DA330EFA164E1', url: 'https://dentai.com.br/odontoclinic' }, '{"status":"ok"}');
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

// browser_harness v2: `exec` runs a Python cell whose helpers drive the same tab, so the gate reads the cell like it reads click/type/evaluate.
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
  // A cell that goes to a sensitive page and then clicks is caught before it runs.
  assert.equal(riskOf(gate, exec("goto('https://checkout.stripe.com/c/pay')\nclick(1)", 'T2')), 'consent click');
  assert.equal(gate.admit(exec("goto('https://example.org/')\nclick(1)", 'T2')), undefined);
  assert.equal(gate.admit(exec("goto('https://checkout.stripe.com/c/pay')\nstate()", 'T2')), undefined, 'looking is not consenting');
  // The old actions behave as before; an exec-shaped `code` on them is ignored.
  assert.equal(riskOf(gate, { ...call(''), tool: 'browser_harness', input: { action: 'click', tab: 'T1', node: 5 } }), 'consent click');
  assert.equal(gate.admit({ ...call(''), tool: 'browser_harness', input: { action: 'evaluate', tab: 'T1', expression: 'document.title', code: 'click(5)' } }), undefined);
  assert.equal(gate.admit({ ...call(''), tool: 'browser_harness', input: { action: 'inspect', tab: 'T1', code: 'click(5)' } }), undefined);
  assert.equal(gate.admit({ ...call(''), tool: 'browser_harness', input: { action: 'state', tab: 'T1', code: 'click(5)' } }), undefined);
  forgetBrowserPages();
});

test('a fetch or XHR written inside an exec cell is a production write like the same text in evaluate', () => {
  forgetBrowserPages();
  const cell = (code: string, tab = 'P1') => lines(classifyEffects({ tool: 'browser_harness', input: { action: 'exec', tab, code }, cwd: '' }, repo));
  observeBrowser({ action: 'open', url: 'https://dentai.com.br/admin' }, '{"status":"ok","tab":"P1"}');
  observeBrowser({ action: 'open', url: 'http://localhost:3000/' }, '{"status":"ok","tab":"L1"}');
  assert.deepEqual(cell("js(\"fetch('https://api.dentai.com.br/x',{method:'PATCH',body:b})\")"), ['production-write https:api.dentai.com.br']);
  assert.deepEqual(cell("r = js('fetch(\\'/api/suppliers/1\\',{method:\"DELETE\"})')"), ['production-write https:dentai.com.br'], 'a relative URL resolves against the tab page');
  assert.deepEqual(cell('js("axios.delete(\'https://usdentai.com/api/users/1\')")'), ['production-write https:usdentai.com']);
  assert.deepEqual(cell('js("fetch(\'https://graph.facebook.com/v19.0/1/messages\',{method:\'POST\',body:b})")'), ['message graph.facebook.com']);
  // goto in the same cell moves the page a relative URL is read against.
  assert.deepEqual(cell("goto('https://usdentai.com/app')\njs(\"fetch('/api/x',{method:'PUT'})\")", 'L1'), ['production-write https:usdentai.com']);
  for (const read of ["js(\"fetch('https://api.dentai.com.br/health')\")", "js(\"fetch('https://api.dentai.com.br/x',{method:'GET'})\")", 'state()', 'click(3)'])
    assert.deepEqual(cell(read), [], read);
  assert.deepEqual(cell("js(\"fetch('/api/x',{method:'POST'})\")", 'L1'), [], 'a local page is not production');
  // An old action does not read `code`.
  assert.deepEqual(lines(classifyEffects({ tool: 'browser_harness', input: { action: 'evaluate', tab: 'P1', code: "js(\"fetch('https://api.dentai.com.br/x',{method:'PATCH'})\")" }, cwd: '' }, repo)), []);
  forgetBrowserPages();
});

test('exec and state results move a tab to the page their header reports; goto fills in when the header has none', () => {
  forgetBrowserPages();
  const consent = (tab: string) => lines(classifyEffects({ tool: 'browser_harness', input: { action: 'exec', tab, code: 'click(1)' }, cwd: '' }, repo));
  observeBrowser({ action: 'open', url: 'https://example.com/' }, '{"status":"ok","tab":"T1"}');
  assert.deepEqual(consent('T1'), []);
  // The header's url is the page after the cell.
  observeBrowser({ action: 'exec', tab: 'T1', code: 'goto(url)' }, '{"status":"ok","tab":"T1","url":"https://pay.google.com/"}\n{"ok":true}');
  assert.deepEqual(consent('T1'), ['consent pay.google.com']);
  observeBrowser({ action: 'state', tab: 'T1' }, '{"status":"ok","tab":"T1","url":"https://example.com/back"}\n[]');
  assert.deepEqual(consent('T1'), [], 'state reports the page too');
  // Only the header counts: a "url" printed by the page or the cell is not the tab address.
  observeBrowser({ action: 'exec', tab: 'T1', code: 'print(js("JSON.stringify(location)"))' }, '{"status":"ok","tab":"T1","url":"https://example.com/back"}\n{"url":"https://pay.google.com/"}');
  assert.deepEqual(consent('T1'), []);
  observeBrowser({ action: 'exec', tab: 'T1', code: 'x' }, 'not a header\n{"tab":"T1","url":"https://pay.google.com/"}');
  assert.deepEqual(consent('T1'), [], 'no header, no move');
  // Without a header url (a timeout), the last goto of the cell is where the tab is heading.
  observeBrowser({ action: 'exec', tab: 'T1', code: "goto('https://example.org/a')\ngoto('https://checkout.stripe.com/c/pay')" }, '{"status":"error","tab":"T1"}');
  assert.deepEqual(consent('T1'), ['consent checkout.stripe.com']);
  observeBrowser({ action: 'exec', tab: 'T1', code: "goto('https://example.org/a')" }, '{"status":"ok","tab":"T1","url":"https://example.com/"}');
  assert.deepEqual(consent('T1'), [], 'the header wins over the goto text');
  // A cell that goes to a non-literal address leaves the page as it was.
  observeBrowser({ action: 'exec', tab: 'T1', code: 'goto(target)' }, '{"status":"error","tab":"T1"}');
  assert.deepEqual(consent('T1'), []);
  observeBrowser({ action: 'state', tab: 'T1' }, '{"status":"ok","tab":"T1","url":"https://example.com/back"}\n[{"url":"https://pay.google.com/"}]');
  assert.deepEqual(consent('T1'), [], 'a url in the state body is not the tab address');
  observeBrowser({ action: 'state', tab: 'T1' }, '{"status":"ok","tab":"T1"}\n[{"url":"https://pay.google.com/"}]');
  assert.deepEqual(consent('T1'), [], 'no url in the header, no move');
  observeBrowser({ action: 'exec', code: 'x' }, '{"status":"ok","url":"https://pay.google.com/"}\n{"tab":"T9"}');
  assert.deepEqual(consent('T9'), [], 'a tab named only by the cell output is not the header');
  // The header names the tab when the call did not.
  observeBrowser({ action: 'exec', code: 'x' }, '{"status":"ok","tab":"T3","url":"https://github.com/settings/tokens"}');
  assert.deepEqual(consent('T3'), ['consent github.com']);
  // Old actions still read the url anywhere in the result, as before.
  observeBrowser({ action: 'click', tab: 'T1', node: 5 }, 'clicked\n{"tab":"T1","url":"https://pay.google.com/"}');
  assert.deepEqual(consent('T1'), ['consent pay.google.com']);
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
  assert.deepEqual(calls.at(-1), ['pr', 'view', '31', '--json', 'statusCheckRollup,mergeStateStatus,headRefOid,headRepository']);
  assert.equal(await mergeRefusal('gh pr merge 31 --squash', 'C:/', exec({ statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }] })), undefined);
  assert.match((await mergeRefusal('gh pr merge 31', 'C:/', exec(new Error('gh not found'))))!, /could not read its checks/, 'unknown CI is not green CI');
  assert.equal(await mergeRefusal('gh pr merge 31 --auto --squash', 'C:/', exec({ ...running, mergeStateStatus: 'BLOCKED' })), undefined);
});

test('a red check whose Actions job never ran a step (GitHub refused to start it: billing) does not block a merge; a job that ran steps does', async () => {
  const sha = '6b02a198341438d5e800cbfdcce9de7874e47d0d';
  const neverRan = { statusCheckRollup: [
    { name: 'changes', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/lennix1337/dotfiles/actions/runs/1/job/11' },
    { name: 'instruction-guard', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/lennix1337/dotfiles/actions/runs/1/job/12' },
    { name: 'offline-suites', status: 'COMPLETED', conclusion: 'SKIPPED' }], mergeStateStatus: 'UNSTABLE', headRefOid: sha, headRepository: { name: 'dotfiles' } };
  const gh = (view: object, steps: Record<string, string>): Exec => async (_c, args) =>
    args[0] === 'api' ? { code: 0, stdout: steps[args[1]!] ?? '', stderr: '' } : { code: 0, stdout: JSON.stringify(view), stderr: '' };
  const zero = { 'repos/lennix1337/dotfiles/actions/jobs/11': '0', 'repos/lennix1337/dotfiles/actions/jobs/12': '0' };
  assert.equal(await mergeRefusal('gh pr merge 78 --squash', 'C:/', gh(neverRan, zero)), undefined, 'no step ran in any red job: nothing failed');
  assert.match((await mergeRefusal('gh pr merge 78 --squash', 'C:/', gh(neverRan, { ...zero, 'repos/lennix1337/dotfiles/actions/jobs/12': '4' })))!, /failing checks/, 'a job that ran steps failed for real');
  assert.match((await mergeRefusal('gh pr merge 78 --squash', 'C:/', gh(neverRan, {})))!, /failing checks/, 'steps that cannot be read are not proof');
  const legacy = { ...neverRan, statusCheckRollup: [{ context: 'ci/legacy', state: 'FAILURE' }] };
  assert.match((await mergeRefusal('gh pr merge 78 --squash', 'C:/', gh(legacy, zero)))!, /failing checks: ci\/legacy/, 'a status without an Actions job is not covered');
});
