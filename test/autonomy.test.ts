import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { classifyEffects, decide, parseContract, type Repo } from '../src/autonomy.ts';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';

/** Checkouts by path, without git: slug and current branch. */
const repos: Record<string, [string, string]> = {
  'c:/projetos/pi-optchat': ['lennix1337/pi-optchat', 'feat/x'],
  'c:/projetos/dotfiles': ['lennix1337/dotfiles', 'main'],
  'c:/projetos/dentai-mono': ['tecnologia-ai/dentai', 'main'],
};
const scripts: Record<string, string> = {
  'c:/projetos/pi-optchat/scratchpad/quality-ab/ab.ts': "import { ModelRuntime } from '@earendil-works/pi-coding-agent'\nawait runtime.prompt(task)",
  'c:/projetos/pi-optchat/scripts/report.mjs': "import { readFileSync } from 'node:fs'\nconsole.log(readFileSync('x', 'utf8'))",
};
const repo: Repo = { slug: (path, remote) => remote === 'fork' ? 'lennix1337/ripwire' : repos[path]?.[0], branch: path => repos[path]?.[1], script: path => scripts[path] };
const effects = (command: string, cwd = 'C:/Users/swluc', tool = 'bash') => classifyEffects({ tool, input: { command }, cwd }, repo)
  .map(e => `${e.action} ${e.targets.join(',')}`.trim());

test('pushes are told apart by destination: a branch, the default branch, or a force push', () => {
  assert.deepEqual(effects('cd C:/projetos/pi-optchat && git push -q -u origin HEAD:fix/heartbeat-wake-clock'), ['push c:/projetos/pi-optchat,lennix1337/pi-optchat']);
  assert.deepEqual(effects('git -C C:/projetos/pi-optchat push origin main'), ['push-main c:/projetos/pi-optchat,lennix1337/pi-optchat']);
  assert.deepEqual(effects('git push origin HEAD:main', 'C:/projetos/pi-optchat'), ['push-main c:/projetos/pi-optchat,lennix1337/pi-optchat']);
  assert.deepEqual(effects('git push', 'C:\\projetos\\dotfiles'), ['push-main c:/projetos/dotfiles,lennix1337/dotfiles'], 'no refspec: the checked-out branch decides');
  assert.deepEqual(effects('git push --force-with-lease origin feat/x', 'C:/projetos/pi-optchat'), ['force-push c:/projetos/pi-optchat,lennix1337/pi-optchat']);
  assert.deepEqual(effects('git push origin +feat/x', 'C:/projetos/pi-optchat'), ['force-push c:/projetos/pi-optchat,lennix1337/pi-optchat']);
  assert.deepEqual(effects('git stash push -m wip'), []);
  assert.deepEqual(effects('git push -u fork fix/win32-cache-ladder-acl', 'C:/projetos/pi-optchat'), ['push c:/projetos/pi-optchat,lennix1337/ripwire'], 'the named remote decides the repository');
});

test('merges, publishing and deploys name the repository they touch', () => {
  assert.deepEqual(effects('gh pr merge 124 --repo tecnologia-ai/dentai --squash'), ['merge c:/users/swluc,tecnologia-ai/dentai']);
  assert.deepEqual(effects('cd C:/projetos/dentai-mono && gh pr merge 86 --squash'), ['merge c:/projetos/dentai-mono,tecnologia-ai/dentai']);
  assert.deepEqual(effects('npm publish --access public', 'C:/projetos/pi-optchat'), ['publish c:/projetos/pi-optchat,lennix1337/pi-optchat']);
  assert.deepEqual(effects('gh release create v4.0.4 -R lennix1337/Genexus18MCP'), ['publish c:/users/swluc,lennix1337/genexus18mcp']);
  assert.deepEqual(effects('cd C:/projetos/dentai-mono && pwsh -File scripts/release/deploy-changed.ps1 -Sha 6f7d5915'), ['deploy c:/projetos/dentai-mono,tecnologia-ai/dentai']);
  assert.deepEqual(effects('gh workflow run deploy-prod.yml -R tecnologia-ai/dentai'), ['deploy c:/users/swluc,tecnologia-ai/dentai']);
  assert.deepEqual(effects('cd C:/projetos/pi-optchat && pwsh -NoProfile -File ./release.ps1 -Version 4.0.4'), ['publish c:/projetos/pi-optchat,lennix1337/pi-optchat']);
  assert.deepEqual(effects('cd C:/projetos/pi-optchat && pwsh -NoProfile -File ./release.ps1 -WhatIf'), []);
  assert.deepEqual(effects('git push origin --delete fix/old', 'C:/projetos/dentai-mono'), ['discard c:/projetos/dentai-mono,tecnologia-ai/dentai'], 'deleting a remote branch is a discard');
  assert.deepEqual(effects('git push origin :fix/old', 'C:/projetos/dentai-mono'), ['discard c:/projetos/dentai-mono,tecnologia-ai/dentai']);
});

test('the production SQL reset that sent a real WhatsApp message is a production write; a read over ssh is not', () => {
  // Shape of the 2026-10-18 incident: a heredoc with an UPDATE piped into psql on the production host.
  const reset = `cat > /tmp/q10.sql <<'EOF'\nupdate retention_simulation_deliveries set status='PENDING' where id='x' and status='FAILED' returning id;\nEOF\nssh -q hetzner-dentai "docker exec -i dentai-postgresdb sh -c 'psql -At'" < /tmp/q10.sql`;
  assert.deepEqual(effects(reset), ['production-write ssh:hetzner-dentai']);
  const read = `cat > /tmp/q7.sql <<'EOF'\nselect id from projects where id='x';\nEOF\nssh -q hetzner-dentai "docker exec -i dentai-postgresdb psql -At" < /tmp/q7.sql`;
  assert.deepEqual(effects(read), []);
  assert.deepEqual(effects('ssh hetzner-dentai "docker compose -f /srv/app.yml up -d api"'), ['production-write ssh:hetzner-dentai']);
  assert.deepEqual(effects('ssh hetzner-dentai "docker ps --format {{.Names}}"'), []);
});

test('paid model calls, discards, deletes and global installs are recognised; inspection is not', () => {
  assert.deepEqual(effects('cd C:/projetos/dotfiles/payload/tools/bench && node bench.mjs run --label ab --model anthropic/claude-opus-5-5:high'), ['paid model-run']);
  assert.deepEqual(effects('pi -p "summarize"'), ['paid model-run']);
  // The 2026-10-24 paid A/B ran as a plain script; its source is what shows it calls a model.
  assert.deepEqual(effects('cd C:/projetos/pi-optchat && npx tsx scratchpad/quality-ab/ab.ts > C:/tmp/ab.log 2>&1'), ['paid model-run']);
  assert.deepEqual(effects('node scripts/report.mjs', 'C:/projetos/pi-optchat'), []);
  assert.deepEqual(effects('node --import tsx --test scratchpad/quality-ab/ab.ts', 'C:/projetos/pi-optchat'), [], 'a test run is not a model run');
  assert.deepEqual(classifyEffects({ tool: 'subagent', input: { agent: 'worker', task: 'x' }, cwd: '' }, repo).map(e => `${e.action} ${e.targets}`), ['paid subagent']);
  assert.deepEqual(classifyEffects({ tool: 'subagent', input: { action: 'list' }, cwd: '' }, repo), []);
  assert.deepEqual(effects('git reset --hard origin/main', 'C:/projetos/dotfiles'), ['discard c:/projetos/dotfiles']);
  assert.deepEqual(effects('pwsh -Command "& ./Invoke-PcMaintenance.ps1 -Steps Worktrees -Apply"'), ['discard pc-maintenance']);
  assert.deepEqual(effects('rm -rf C:/projetos/old-thing'), ['recursive-delete c:/projetos/old-thing']);
  assert.deepEqual(effects('rm -rf /tmp/radmut'), []);
  assert.deepEqual(effects('npm i -g agent-browser'), ['global-install machine']);
  assert.deepEqual(effects('git status && npm test'), []);
  assert.deepEqual(classifyEffects({ tool: 'read', input: { path: 'x' }, cwd: '' }, repo), []);
});

test('text that only mentions a command is not that command: greps, reads, help and heredoc bodies', () => {
  // Each of these was flagged by the first replay of the real history.
  assert.deepEqual(effects('cd C:/projetos/Genexus18MCP && grep -nE "git push|push origin|gh release create|npm publish|gh pr merge" release.ps1'), []);
  assert.deepEqual(effects("cd C:/projetos/dentai-mono && sed -n '1,175p' scripts/release/deploy-changed.ps1"), []);
  assert.deepEqual(effects('wrangler deploy --help | head -65'), []);
  assert.deepEqual(effects('cd C:/projetos/dentai-mono && pwsh -NoProfile -File scripts/release/deploy-changed.ps1 -PlanOnly'), [], 'a plan-only run deploys nothing');
  assert.deepEqual(effects("python - <<'PY'\nimport subprocess\nsubprocess.run('git push origin main')\nPY\necho done"), []);
  assert.deepEqual(effects('git commit -m "docs: explain why we never run gh pr merge --admin; use git push only on branches"'), []);
});

test('relative paths are resolved against cd and the working directory; deletes inside temp folders are free', () => {
  assert.deepEqual(effects('git -C worktrees/denta-81 push -u origin lennix1337/denta-81', 'C:/projetos/dentai-mono'), ['push c:/projetos/dentai-mono/worktrees/denta-81']);
  assert.deepEqual(effects('cd /tmp && rm -rf wa ws && mkdir wa ws'), []);
  assert.deepEqual(effects('mkdir -p /c/temp && cd /c/temp && rm -rf gx-wiki'), []);
  assert.deepEqual(effects('cd C:/projetos && rm -rf old-thing'), ['recursive-delete c:/projetos/old-thing']);
  assert.deepEqual(effects('T=$(mktemp -d) && cp -r ~/.optmem/memory $T/m && rm -rf $T'), [], 'a folder the script made with mktemp is temp');
  assert.deepEqual(effects('O=/c/tmp/gxe-bench; rm -rf $O; mkdir -p $O'), []);
  assert.deepEqual(effects('D=$(git rev-parse --show-toplevel); rm -rf $D'), ['recursive-delete $d'], 'an unknown value stays strict');
  assert.deepEqual(effects('R=main; git push origin $R', 'C:/projetos/pi-optchat'), ['push-main c:/projetos/pi-optchat,lennix1337/pi-optchat']);
  assert.deepEqual(effects('for n in 83 85 86; do gh pr merge $n --repo tecnologia-ai/dentai --squash; done'), ['merge c:/users/swluc,tecnologia-ai/dentai']);
  assert.deepEqual(effects('git push origin > /c/tmp/push.log 2>&1', 'C:/projetos/dotfiles'), ['push-main c:/projetos/dotfiles,lennix1337/dotfiles'], 'a redirection is not a refspec');
});

test('malformed or truncated commands never throw: the gate must not crash on odd input', () => {
  for (const command of ['git -C', 'git -c', 'gh pr merge --repo', 'git push --repo', 'rm -rf', 'cd', 'pwsh -Command', 'bash -c', "echo 'unterminated", 'cat <<EOF', '&&;||', 'ssh', 'npx', ''])
    assert.doesNotThrow(() => effects(command), command);
});

test('a codemode script is judged by the shell commands it hands to tools and the model calls it makes', () => {
  const code = (source: string) => classifyEffects({ tool: 'codemode', input: { code: source }, cwd: 'C:/projetos/pi-optchat' }, repo).map(e => `${e.action} ${e.targets.join(',')}`);
  assert.deepEqual(code('await tools.bash({ command: "git push origin main", timeout: 30 });'), ['push-main c:/projetos/pi-optchat,lennix1337/pi-optchat']);
  assert.deepEqual(code('const r = await tools.read({ path: "README.md" }); // mentions git push'), []);
  assert.deepEqual(code('await tools.spawn({ tasks: [{ task: "x" }] });'), ['paid subagent']);
});

const contract = parseContract({
  version: 1, default: 'advisor',
  rules: [
    { action: 'push', scope: ['lennix1337/*'], level: 'free', note: 'own branches' },
    { action: 'push-main', scope: ['lennix1337/pi-*', 'lennix1337/dotfiles'], level: 'report', note: 'Pi forks and dotfiles after gates' },
    { action: 'merge', scope: ['tecnologia-ai/*'], level: 'ask', note: 'DentAI merges need a per-PR OK' },
    { action: 'merge', scope: ['tecnologia-ai/dentai'], level: 'free', note: 'never reached: the rule above matches first' },
    { action: 'deploy', scope: ['*'], level: 'ask' },
    { action: 'production-write', scope: ['*'], level: 'ask' },
    { action: 'paid', scope: ['*'], level: 'ask', until: '2026-01-01T00:00:00Z', note: 'expired' },
    { action: 'force-push', scope: ['*'], level: 'ask' },
  ],
});
const verdict = (command: string, cwd = 'C:/Users/swluc') => decide(contract, classifyEffects({ tool: 'bash', input: { command }, cwd }, repo), Date.parse('2026-10-28T00:00:00Z')).level;

test('the first live rule that matches the action and a target decides; otherwise the default', () => {
  assert.equal(verdict('git push -u origin feat/x', 'C:/projetos/pi-optchat'), 'free');
  assert.equal(verdict('git -C C:/projetos/dotfiles push origin main'), 'report');
  assert.equal(verdict('git push origin main', 'C:/projetos/dentai-mono'), 'advisor', 'no rule names push-main on DentAI');
  assert.equal(verdict('gh pr merge 86 --repo tecnologia-ai/dentai'), 'ask', 'rule order, not specificity, decides');
  assert.equal(verdict('node bench.mjs run --label x'), 'advisor', 'an expired rule no longer applies');
  assert.equal(verdict('git status'), 'advisor', 'no effect: nothing to decide here; the gate already let it through');
});

test('a call with several effects gets the strictest decision', () => {
  assert.equal(verdict('git push -u origin feat/x && pwsh -File deploy-changed.ps1', 'C:/projetos/pi-optchat'), 'ask');
  assert.equal(verdict('git push origin feat/x --force', 'C:/projetos/pi-optchat'), 'ask');
});

test('an invalid contract names its problem', () => {
  assert.throws(() => parseContract({ version: 2, rules: [] }), /version/);
  assert.throws(() => parseContract({ version: 1, rules: [{ action: 'yolo', scope: ['*'], level: 'free' }] }), /rule 1: action/);
  assert.throws(() => parseContract({ version: 1, rules: [{ action: 'push', scope: [], level: 'free' }] }), /rule 1: scope/);
  assert.throws(() => parseContract({ version: 1, rules: [{ action: 'push', scope: ['*'], level: 'maybe' }] }), /rule 1: level/);
  assert.throws(() => parseContract({ version: 1, rules: [{ action: 'push', scope: ['*'], level: 'free', until: 'soon' }] }), /rule 1: until/);
  assert.throws(() => parseContract({ version: 1, default: 'yes', rules: [] }), /default/);
});

/** The registered gate in risk mode with a profile folder holding `contract`, and an advisor that approves everything. */
function gate(contractText: string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-'));
  if (contractText !== undefined) writeFileSync(join(dir, 'autonomy.json'), contractText);
  const hooks = new Map<string, (...args: any[]) => any>();
  const asked: string[] = [], notices: string[] = [];
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled: true, mode: 'risk', bell: () => {}, repo, contractDir: () => dir,
    advisor: async request => { asked.push((request.input as { command: string }).command); return { approve: true, reason: 'looks fine', model: 'm' }; } });
  const ctx = { cwd: 'C:/projetos/pi-optchat', sessionManager: { getSessionId: () => 'owner', getBranch: () => [] },
    ui: { notify: (message: string) => notices.push(message), setWidget: () => {} } };
  const call = (command: string) => hooks.get('tool_call')!({ toolName: 'bash', toolCallId: command, input: { command } }, ctx);
  return { dir, asked, notices, call, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the gate follows autonomy.json before any advisor: ask waits for the operator even when the advisor would approve', async () => {
  const g = gate(JSON.stringify({ version: 1, rules: [{ action: 'merge', scope: ['tecnologia-ai/*'], level: 'ask', note: 'per-PR OK' }] }));
  const refused = await g.call('gh pr merge 86 --repo tecnologia-ai/dentai --squash');
  assert.equal(refused.block, true);
  assert.match(refused.reason, /autonomy\.json says this waits for the operator: merge on .*tecnologia-ai\/dentai: ask \(rule merge tecnologia-ai\/\* : per-PR OK\)|autonomy\.json says this waits for the operator: merge on .*tecnologia-ai\/dentai: ask/);
  assert.match(refused.reason, /\/approve/);
  assert.deepEqual(g.asked, [], 'the advisor never sees a call the contract reserves for the operator');
  assert.equal((await g.call('gh pr merge 86 --repo tecnologia-ai/dentai --squash')).block, true, 'retrying does not change it');
  g.done();
});

test('free runs without the advisor; report runs and leaves a line for the briefing', async () => {
  const g = gate(JSON.stringify({ version: 1, rules: [
    { action: 'push', scope: ['lennix1337/*'], level: 'free' },
    { action: 'push-main', scope: ['lennix1337/pi-*'], level: 'report', note: 'after gates' },
  ] }));
  assert.equal(await g.call('git push -u origin feat/x'), undefined);
  assert.equal(await g.call('git push origin HEAD:main'), undefined);
  assert.deepEqual(g.asked, []);
  const log = readFileSync(join(g.dir, 'autonomy-log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => [entry.action, entry.targets, entry.summary, entry.rule]),
    [['push-main', ['c:/projetos/pi-optchat', 'lennix1337/pi-optchat'], 'git push origin HEAD:main (in pi-optchat)', 'after gates']]);
  assert.ok(g.notices.some(text => /Ran under autonomy\.json \(report\)/.test(text)));
  g.done();
});

test('an effect without a rule still goes to the advisor; without a contract nothing changes', async () => {
  const g = gate(JSON.stringify({ version: 1, rules: [{ action: 'push', scope: ['someone-else/*'], level: 'ask' }] }));
  assert.equal(await g.call('git push -u origin feat/x'), undefined);
  assert.deepEqual(g.asked, ['git push -u origin feat/x']);
  g.done();
  const none = gate(undefined);
  assert.equal(await none.call('git push -u origin feat/x'), undefined);
  assert.deepEqual(none.asked, ['git push -u origin feat/x']);
  none.done();
});

test('an unreadable contract fails closed: every high-impact call waits for the operator', async () => {
  const g = gate('{ "version": 1, "rules": [ { "action": "push"');
  const refused = await g.call('git push -u origin feat/x');
  assert.equal(refused.block, true);
  assert.match(refused.reason, /autonomy\.json is unreadable/);
  assert.deepEqual(g.asked, []);
  assert.equal(await g.call('git status'), undefined, 'ordinary work is untouched');
  g.done();
});

test('the agent cannot widen its own contract: touching autonomy.json waits for the operator, whatever the rules say', async () => {
  const g = gate(JSON.stringify({ version: 1, default: 'free', rules: [{ action: '*', scope: ['*'], level: 'free' }] }));
  const refused = await g.call(`echo '{"version":1,"default":"free","rules":[]}' > ${g.dir}/autonomy.json`);
  assert.equal(refused.block, true);
  assert.match(refused.reason, /Only the operator changes autonomy\.json/);
  assert.deepEqual(g.asked, [], 'the advisor is not asked either');
  g.done();
});

test('risk mode now stops deploys and production writes, which used to pass it unseen', async () => {
  const g = gate(undefined);
  await g.call('ssh hetzner-dentai "psql -c \\"delete from leads where id=1\\""');
  await g.call('pwsh -File scripts/release/deploy-changed.ps1');
  assert.equal(g.asked.length, 2, 'both reached the gate (and its advisor)');
  g.done();
});
