import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, scanCorrections, rules } from '../src/correction-scan.ts';
import { composeScoreboard } from '../src/scoreboard.ts';

const message = (content: object, stopReason: string) => ({ type: 'message', timestamp: '2026-11-14T00:00:00Z', message: { role: 'assistant', stopReason, content: [content] } });
const text = (s: string) => message({ type: 'text', text: s }, 'stop');
const call = (name: string, args: object) => message({ type: 'toolCall', name, arguments: args }, 'toolUse');
const cases: [string, object, object][] = [
 ['free-action', text('Posso mergear?'), text('Merge concluído.')],
 ['ending-offer', text('Se quiser, é só dizer.'), text('Diga o resultado.')],
 ['pipe-status', call('bash',{command:'npm test | tail; echo rc=$?'}), call('bash',{command:'npm test | tail; echo rc=${PIPESTATUS[0]}'})],
 ['weaken-test', call('edit',{path:'test/example.test.ts',edits:[{oldText:'timeout: 1000',newText:'timeout: 2000'}]}), call('edit',{path:'src/example.ts',edits:[{oldText:'timeout: 1000',newText:'timeout: 2000'}]})],
 ['memory-format', text('UNRESOLVED'), text('Concluído.')],
 ['utc-time', text('Às 03:17Z.'), text('Às 00:17.')],
 ['force-action', call('bash',{command:'git push --force'}), call('bash',{command:'git push origin main'})],
 ['unchecked-own-work', text('O worker foi relançado. Não confirmei que ele começou de fato.'), text('O worker está rodando: tarefa Running e passo 43 no log.')],
 ['cause-claim', call('bash',{command:'gh issue comment 168 --body "Causa achada: o merge com GITHUB_TOKEN não dispara push."'}), call('bash',{command:'gh issue comment 168 --body "Hipótese, não verificada: o merge com GITHUB_TOKEN pode não disparar push."'})],
 ['premature-merge', call('bash',{command:'gh pr merge 193 --squash --delete-branch'}), call('bash',{command:'gh pr checks 193 && gh pr merge 193 --squash'})],
 ['live-claim', call('slack_send',{text:'No ar às 10:52: a correção do Seus Projetos.'}), call('slack_send',{text:'Mesclei o #192; o deploy ainda não foi verificado.'})],
 ['abandoned-cause', text('Stalls were 3132 ms; cause NOT found. Vou cuidar dos PRs.'), text('A causa foi encontrada no carregamento.')],
];
for (const [id, yes, no] of cases) test(`detector ${id} distinguishes fixtures`, () => {
 const rule = rules.find(r => r.id === id)!; assert.ok(rule); assert.equal(detect(rule, yes), true); assert.equal(detect(rule, no), false);
});
test('abandoned-cause scopes unresolved-cause statements to assistant final reports', () => {
 const rule = rules.find(r => r.id === 'abandoned-cause')!;
 for (const s of ['A causa não foi encontrada.', 'Continuam sem causa encontrada: a queda e as travadas.', 'Causas não encontradas: o RSS e o wake.', 'The cause is still not found.']) assert.equal(detect(rule, text(s)), true, s);
 assert.equal(detect(rule, message({type:'text',text:'causa não encontrada'}, 'toolUse')), false);
 assert.equal(detect(rule, {...text('causa não encontrada'), message:{role:'user',stopReason:'stop',content:[{type:'text',text:'causa não encontrada'}]}}), false);
 assert.equal(detect(rule, call('bash',{command:'echo "cause NOT found"'})), false);
});

const pacing = (s = 'Use os workers porque sua quota está acabando.') => ({...text(s), message:{role:'user',content:[{type:'text',text:s}]}});
const selfWork = [call('bash',{command:'rg -n stall src'}), call('edit',{path:'src/stall.ts',edits:[]}), call('bash',{command:'node probe.mjs'})];
function pacingCount(events: object[], before: object[] = [], otherSession: object[] = []): number {
 const dir = mkdtempSync(join(tmpdir(), 'pacing-rules-'));
 try {
  writeFileSync(join(dir,'session.jsonl'), [...before.map(e=>({...e,timestamp:'2026-11-13T23:59:00Z'})), ...events].map(e=>JSON.stringify(e)).join('\n'));
  if (otherSession.length) writeFileSync(join(dir,'other.jsonl'), otherSession.map(e=>JSON.stringify(e)).join('\n'));
  return scanCorrections(dir, Date.parse('2026-11-14'), Date.parse('2026-11-15')).find(r=>r.id==='self-work-under-pacing')!.count;
 } finally { rmSync(dir,{recursive:true,force:true}); }
}
const wakePrompt = { type: 'custom_message', customType: 'optchat-report', timestamp: '2026-11-14T00:00:00Z', content: '[OptChat heartbeat] You have been idle for 15 min and the operator is away.' };
const operator = { type: 'message', timestamp: '2026-11-14T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'oi' }] } };
function wakeSilenceCount(events: object[]): number {
 const dir = mkdtempSync(join(tmpdir(), 'wake-silence-'));
 try {
  writeFileSync(join(dir, 'session.jsonl'), events.map(e => JSON.stringify(e)).join(String.fromCharCode(10)));
  return scanCorrections(dir, Date.parse('2026-11-14'), Date.parse('2026-11-15')).find(r => r.id === 'wake-silence')!.count;
 } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('wake-silence flags a wake run that ends in a memory line, a re-asked operator item or a "nothing new" report (15/11 17:12, 17:22)', () => {
 for (const bad of ['15/11 164386-: 17:12 wake heartbeat (machine notice, not user words; 164385). Radar fine.', '15/11 164384-387 OptChat: 17:22 wake', 'c_022f4e waiting_operator 2d9h past due, ainda aguardando.', 'Nada novo desde o último wake.'])
  assert.equal(wakeSilenceCount([wakePrompt, text(bad)]), 1, bad);
 assert.equal(wakeSilenceCount([wakePrompt, call('bash', { command: 'git status' }), text('Abri a PR #97 com o ajuste do radar.')]), 0, 'a delivered report is fine');
});
test('wake-silence counts only runs that a heartbeat prompt started', () => {
 const bad = text('15/11 164386-: 17:12 wake heartbeat (machine notice, not user words)');
 assert.equal(wakeSilenceCount([bad]), 0, 'no wake before it');
 assert.equal(wakeSilenceCount([wakePrompt, operator, bad]), 0, 'the operator spoke after the wake prompt');
 assert.equal(wakeSilenceCount([{ ...wakePrompt, content: 'Subagent finished' }, bad]), 0, 'another report is not a wake');
 assert.equal(wakeSilenceCount([wakePrompt, message({ type: 'text', text: 'Nada novo.' }, 'toolUse')]), 0, 'a mid-run text is not a final report');
 assert.equal(wakeSilenceCount([wakePrompt, bad, operator, bad]), 1);
});
test('self-work-under-pacing counts sustained direct work, not one quick manager action', () => {
 assert.equal(pacingCount([pacing(), ...selfWork]), 1);
 assert.equal(pacingCount([pacing(), ...selfWork, ...selfWork]), 1, 'one candidate per uninterrupted run');
 assert.equal(pacingCount([pacing(), ...selfWork.slice(0,2)]), 0);
 assert.equal(pacingCount(selfWork), 0);
 assert.equal(pacingCount([text('A minha cota semanal está gastando mais rápido do que a semana passa.'), ...selfWork]), 1);
 assert.equal(pacingCount(selfWork, [pacing()]), 1, 'context before the reporting interval still applies');
 assert.equal(pacingCount(selfWork, [], [pacing()]), 0, 'context cannot leak between sessions');
});
test('self-work-under-pacing resets on actual delegation, not a promise or a worker mention', () => {
 for (const delegation of [call('spawn',{kind:'code',task:'investigate'}), call('tell',{id:'abc',text:'continue investigating'}), call('bash',{command:'node ~/.pi/agent/bin/agy-worker.mjs < task.md'}), call('shell_start',{command:'node C:/tools/agy-worker.mjs < task.md'})]) {
  assert.equal(pacingCount([pacing(), ...selfWork.slice(0,2), delegation, selfWork[2]]), 0);
  assert.equal(pacingCount([pacing(), ...selfWork, delegation, ...selfWork]), 2);
 }
 assert.equal(pacingCount([pacing(), ...selfWork.slice(0,2), text('Vou delegar a um worker.'), selfWork[2]]), 1);
 assert.equal(pacingCount([pacing(), ...selfWork.slice(0,2), call('bash',{command:'cat agy-worker.mjs'}), selfWork[2]]), 1);
 assert.equal(pacingCount([pacing(), ...selfWork.slice(0,2), call('crew',{action:'list'}), selfWork[2]]), 1);
 for (const command of ['node ~/.pi/agent/bin/agy-worker.mjs --quota', 'node ~/.pi/agent/bin/agy-worker.mjs --help', 'echo "node ~/.pi/agent/bin/agy-worker.mjs"']) assert.equal(pacingCount([pacing(),...selfWork.slice(0,2),call('bash',{command}),selfWork[2]]),1,command);
});
test('self-work-under-pacing ignores quoted signals, healthy quota and unrelated tool calls', () => {
 const result = {...text('Quota pacing active; use workers.'), message:{role:'toolResult',content:[{type:'text',text:'Quota pacing active; use workers.'}]}};
 for (const signal of [result, text('A quota está normal.'), pacing('A quota está acabando?'), pacing('O worker disse: "minha quota está acabando".')]) assert.equal(pacingCount([signal,...selfWork]), 0);
 assert.equal(pacingCount([pacing(),call('read',{path:'src/stall.ts'}),call('zoom',{id:1}),call('shell_status',{id:'abc'})]), 0);
 assert.equal(pacingCount([pacing(),...selfWork.slice(0,2),pacing('Quota pacing ended.'),selfWork[2]]), 0);
 assert.equal(pacingCount([pacing(),message({type:'toolCall',name:'bash',arguments:{command:'rg stall src'}},'toolUse'), {...call('bash',{}),message:{role:'toolResult',content:[{type:'toolCall',name:'edit'}]}}]), 0);
});
test('self-work-under-pacing accepts native user strings and ignores malformed content', () => {
 assert.equal(pacingCount([{...pacing(), message:{role:'user',content:'Use os workers porque sua quota está acabando.'}}, ...selfWork]),1);
 assert.equal(pacingCount([{...pacing(), message:{role:'user',content:{text:'Use os workers porque sua quota está acabando.'}}}, ...selfWork]),0);
});
test('self-work-under-pacing sees parallel direct calls and delegation wrappers', () => {
 const parallel = (calls: object[]) => call('multi_tool_use.parallel',{tool_uses:calls});
 const work = [{recipient_name:'functions.bash',parameters:{command:'rg stall src'}},{recipient_name:'functions.edit',parameters:{path:'src/stall.ts',edits:[]}},{recipient_name:'functions.write',parameters:{path:'probe.mjs',content:'probe'}}];
 assert.equal(pacingCount([pacing(),parallel(work)]),1);
 assert.equal(pacingCount([pacing(),...selfWork.slice(0,2),parallel([{recipient_name:'functions.spawn',parameters:{kind:'code',task:'investigate'}}]), selfWork[2]]),0);
});

test('scoreboard displays measured candidates and distinguishes unavailable scans', () => {
 const inputs = { from: 0, to: 86400000, slack: { received: 0, answered: 0, nudges: 0, waiting: 0 }, corrections: { count: 0 }, merged: { green: 0, other: 0 } };
 assert.match(composeScoreboard({ ...inputs, ruleViolations: 3 }), /Regras violadas \(7d\): \*3\* candidatos/);
 assert.match(composeScoreboard(inputs), /Regras violadas \(7d\): não medido/);
});
test('scan applies time bounds and caps locations without message text', () => {
 const dir = mkdtempSync(join(tmpdir(), 'rules-')); try {
  writeFileSync(join(dir,'a.jsonl'), [...Array(5)].map(()=>JSON.stringify(text('Posso mergear?'))).join('\n')+'\n');
  const result = scanCorrections(dir, Date.parse('2026-11-13'), Date.parse('2026-11-15'));
  assert.equal(result.find(r=>r.id==='free-action')?.count,5); assert.equal(result[0].examples.length,3);
  assert.deepEqual(Object.keys(result[0].examples[0]).sort(),['file','line']);
  assert.equal(scanCorrections(dir,Date.parse('2026-11-15'),Date.parse('2026-11-16'))[0].count,0);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('scan skips files untouched since the window and a half-written last line', () => {
 const dir = mkdtempSync(join(tmpdir(), 'rules-')); try {
  writeFileSync(join(dir,'live.jsonl'), JSON.stringify(text('Posso mergear?'))+'\n{"type":"mess');
  writeFileSync(join(dir,'old.jsonl'), JSON.stringify(text('Posso mergear?'))+'\n');
  utimesSync(join(dir,'old.jsonl'), new Date('2026-11-01'), new Date('2026-11-01'));
  assert.equal(scanCorrections(dir, Date.parse('2026-11-13'), Date.parse('2026-11-15')).find(r=>r.id==='free-action')?.count, 1);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('cause-claim flags only gh issue/PR comments or closes that state a cause as fact (18/11 #168)', () => {
 const rule = rules.find(r => r.id === 'cause-claim')!;
 for (const c of ['gh issue close 168 -c "Root cause found: token"', 'gh pr comment 5 --body "A causa raiz é o cache"', 'gh issue comment 1 -b "causa encontrada"']) assert.equal(detect(rule, call('bash',{command:c})), true, c);
 for (const c of ['gh issue comment 1 -b "causa encontrada (hipótese, não verificada)"', 'echo "causa achada"', 'gh issue comment 1 -b "Resolvida pelo #170"']) assert.equal(detect(rule, call('bash',{command:c})), false, c);
 assert.equal(detect(rule, text('Causa achada: o cache.')), false);
});
test('cause-claim also flags a WhatsApp/Slack report that states a cause as found (18/11 wacli "Achei o buraco")', () => {
 const rule = rules.find(r => r.id === 'cause-claim')!;
 assert.equal(detect(rule, call('whatsapp_send',{text:'Achei o buraco: o wacli não avisou a sessão.'})), true);
 assert.equal(detect(rule, call('slack_send',{text:'Achei a causa: o cache.'})), true);
 assert.equal(detect(rule, call('whatsapp_send',{text:'Hipótese, não verificada: o aviso do wacli não saiu.'})), false);
 assert.equal(detect(rule, call('slack_send',{text:'Corrigi o envio; a causa ainda não foi achada.'})), false);
});
test('premature-merge ignores auto-merge and merges that carry verify evidence', () => {
  const rule = rules.find(r => r.id === 'premature-merge')!;
  for (const c of ['gh pr merge 5 --auto --squash', 'npm run verify && gh pr merge 5 --squash', 'gh pr view 5 --json statusCheckRollup && gh pr merge 5', 'echo gh']) assert.equal(detect(rule, call('bash',{command:c})), false, c);
  assert.equal(detect(rule, call('bash',{command:'cd repo && gh pr merge 9 --squash'})), true);
  assert.equal(detect(rule, call('bash',{command:'gh pr merge 9 --squash | tail -1; echo done'})), true);
  for (const c of ['gh pr merge 430 --disable-auto', 'node -e "m.ownMerges(\'gh pr merge 9 --squash\')"', 'git commit -m "gh pr merge --disable-auto nao conta como merge"', 'gh pr diff 40 | grep "gh pr merge"']) assert.equal(detect(rule, call('bash',{command:c})), false, c);
});

test('scan reads sessions kept in per-project subdirectories of the sessions root (the VM layout)', () => {
 const root = mkdtempSync(join(tmpdir(), 'rules-root-')); try {
  mkdirSync(join(root, '--home-ubuntu--')); mkdirSync(join(root, '--home-ubuntu-scratch--'));
  writeFileSync(join(root, '--home-ubuntu--', 'a.jsonl'), JSON.stringify(text('Posso mergear?')) + '\n');
  writeFileSync(join(root, '--home-ubuntu-scratch--', 'b.jsonl'), JSON.stringify(text('Posso mergear?')) + '\n');
  const result = scanCorrections(root, Date.parse('2026-11-13'), Date.parse('2026-11-15'));
  assert.equal(result.find(r => r.id === 'free-action')?.count, 2);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test('premature-merge does not count a merge the guard refused ("Not run:"), only the ones that ran', () => {
 const dir = mkdtempSync(join(tmpdir(), 'rules-')); try {
  const at = '2026-11-14T12:00:00Z';
  const merge = (id: string) => ({ type: 'message', timestamp: at, message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command: 'gh pr merge 5 --squash' } }] } });
  const result = (id: string, out: string) => ({ type: 'message', timestamp: at, message: { role: 'toolResult', toolCallId: id, toolName: 'bash', isError: out.startsWith('Not run:'), content: [{ type: 'text', text: out }] } });
  writeFileSync(join(dir,'a.jsonl'), [merge('refused'), result('refused','Not run: PR 5 is not mergeable over green CI: checks still running.'), merge('ran'), result('ran','merged')].map(e => JSON.stringify(e)).join('\n')+'\n');
  const found = scanCorrections(dir, Date.parse('2026-11-13'), Date.parse('2026-11-15')).find(r => r.id === 'premature-merge')!;
  assert.equal(found.count, 1); assert.deepEqual(found.examples, [{ file: 'a.jsonl', line: 3 }]);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('a rule with a guard reports how many violations happened after the guard went live', () => {
 const pipe = (timestamp: string) => ({ ...call('bash', { command: 'npm test | tail -3; echo rc=' + '$' + '?' }), timestamp });
 const dir = mkdtempSync(join(tmpdir(), 'after-guard-'));
 try {
  writeFileSync(join(dir, 'session.jsonl'), [pipe('2026-11-18T10:00:00Z'), pipe('2026-11-18T11:00:00Z'), pipe('2026-11-20T10:00:00Z')].map(e => JSON.stringify(e)).join('\n'));
  const found = scanCorrections(dir, Date.parse('2026-11-17'), Date.parse('2026-11-21'));
  const row = found.find(r => r.id === 'pipe-status')!;
  assert.deepEqual([row.count, row.afterGuard], [3, 1]);
  assert.equal(found.find(r => r.id === 'force-action')!.afterGuard, undefined, 'an unguarded rule has no after-guard count');
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a pipe-status call the guard refused ("Not run:") is not a violation after the guard', () => {
 const bad = { ...call('bash', { command: 'npm test | tail -3; echo rc=' + '$' + '?' }), timestamp: '2026-11-20T10:00:00Z' };
 (bad.message.content[0] as { id?: string }).id = 'c1';
 const refused = { type: 'message', timestamp: '2026-11-20T10:00:01Z', message: { role: 'toolResult', toolCallId: 'c1', content: [{ type: 'text', text: 'Não executado: troque rc por PIPESTATUS' }] } };
 const dir = mkdtempSync(join(tmpdir(), 'refused-pipe-'));
 try {
  writeFileSync(join(dir, 'session.jsonl'), [bad, refused].map(e => JSON.stringify(e)).join('\n'));
  const row = scanCorrections(dir, Date.parse('2026-11-19'), Date.parse('2026-11-21')).find(r => r.id === 'pipe-status')!;
  assert.deepEqual([row.count, row.afterGuard], [0, 0]);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('pipe-status ignores the pattern inside quoted text or a heredoc, as in code that only mentions it', () => {
 const rule = rules.find(r => r.id === 'pipe-status')!;
 for (const command of ["cat > t.ts <<'EOF'\nrun('npm test | tail -5; echo rc=$?')\nEOF", 'git commit -m "o guard recusa `cmd | tail; echo rc=$?`"', "echo 'make | grep x; echo rc=$?'"]) assert.equal(detect(rule, call('bash', { command })), false, command);
 assert.equal(detect(rule, call('bash', { command: 'make | tail -3; echo rc=$?' })), true);
});

test('pipe-status does not flag a pipe that ends before an && chain', () => {
 const rule = rules.find(r => r.id === 'pipe-status')!;
 assert.equal(detect(rule, call('bash', { command: 'git status | head -4 && node t.mjs > log 2>&1; echo rc=$?' })), false);
 assert.equal(detect(rule, call('bash', { command: 'make 2>&1 | tail -3; echo rc=$?' })), true);
});
test('a quoted admission or cause phrase is a citation, not a violation', () => {
 for (const [id, s] of [['unchecked-own-work', 'A regra proíbe "Não confirmei que ele começou" e eu cumpro.'], ['abandoned-cause', 'O detector procura “causa não encontrada” nos relatórios.']] as const) {
  assert.equal(detect(rules.find(r => r.id === id)!, text(s)), false, id);
 }
});
function ruleCount(id: string, events: object[]): number {
 const dir = mkdtempSync(join(tmpdir(), 'rule-count-'));
 try {
  writeFileSync(join(dir, 'session.jsonl'), events.map(e => JSON.stringify(e)).join(String.fromCharCode(10)));
  return scanCorrections(dir, Date.parse('2026-11-14'), Date.parse('2026-11-15')).find(r => r.id === id)!.count;
 } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('self-build-in-wake counts a wake that edits source three times without handing it to a worker', () => {
 const edit = (path: string) => call('edit', { path, edits: [] });
 const build = [edit('src/a.ts'), call('bash', { command: 'npm test' }), edit('test/a.test.ts'), call('write', { path: 'src/b.ts', content: '' })];
 assert.equal(ruleCount('self-build-in-wake', [wakePrompt, ...build]), 1);
 assert.equal(ruleCount('self-build-in-wake', [wakePrompt, ...build, ...build]), 1, 'one candidate per uninterrupted run');
 assert.equal(ruleCount('self-build-in-wake', build), 0, 'the operator\'s own task is not a wake');
 assert.equal(ruleCount('self-build-in-wake', [wakePrompt, operator, ...build]), 0, 'the operator spoke: his task now');
 assert.equal(ruleCount('self-build-in-wake', [wakePrompt, ...Array(6).fill(call('bash', { command: 'gh pr list' }))]), 0, 'reads and reviews are not building');
 assert.equal(ruleCount('self-build-in-wake', [wakePrompt, ...build.slice(0, 2), call('shell_start', { command: 'node ~/.pi/agent/bin/agy-pc.mjs --repo C:\\projetos\\x --name y < b.md' }), ...build.slice(2)]), 0, 'agy-pc delegation resets it');
 assert.equal(ruleCount('self-build-in-wake', [wakePrompt, edit('a'), call('spawn', { tasks: [] }), edit('b'), edit('c')]), 0, 'spawn resets it');
});

test('dentai-in-wake flags a wake that writes to DentAI, not one that only reads it or the operator\'s own task', () => {
 const push = call('bash', { command: 'cd ~/projetos/dentai-mono && git push origin fix/x' });
 const pr = call('bash', { command: 'gh pr merge 195 --repo tecnologia-ai/dentai --auto --squash' });
 assert.equal(ruleCount('dentai-in-wake', [wakePrompt, push]), 1);
 assert.equal(ruleCount('dentai-in-wake', [wakePrompt, pr]), 1);
 assert.equal(ruleCount('dentai-in-wake', [wakePrompt, call('bash', { command: 'node ~/.pi/agent/bin/dentai-ship.mjs 195' })]), 1);
 assert.equal(ruleCount('dentai-in-wake', [wakePrompt, call('bash', { command: 'cd ~/projetos/dentai-mono && git log --oneline -3 && gh pr list --repo tecnologia-ai/dentai' })]), 0, 'reads are fine');
 assert.equal(ruleCount('dentai-in-wake', [wakePrompt, call('bash', { command: 'git push origin main' })]), 0, 'other repos are fine');
 assert.equal(ruleCount('dentai-in-wake', [push]), 0, 'outside a wake it is his order');
 assert.equal(ruleCount('dentai-in-wake', [wakePrompt, operator, push]), 0, 'the operator spoke: his task now');
});
test('self-build-in-wake counts shell writes and survives other reports until the operator speaks', () => {
 const claimCheck = { ...wakePrompt, content: '[OptChat claim check] the reply admits it did not check' };
 const shellBuild = [call('bash', { command: "cat >> test/a.test.ts <<'X'\nx\nX" }), call('bash', { command: "python3 - <<'X'\nopen('src/a.ts','w').write('')\nX" }), call('bash', { command: 'git commit -am fix' })];
 assert.equal(ruleCount('self-build-in-wake', [wakePrompt, ...shellBuild]), 1);
 assert.equal(ruleCount('self-build-in-wake', [wakePrompt, shellBuild[0], claimCheck, ...shellBuild.slice(1)]), 1, 'a claim check does not end the wake');
 assert.equal(ruleCount('self-build-in-wake', [wakePrompt, ...Array(3).fill(call('bash', { command: 'npm test > /tmp/full.log 2>&1; cat > /tmp/x.ts' }))]), 0, 'scratch files in /tmp are not building');
});

test('live-claim is cleared by a live check since the last user message, and reset by the next one', () => {
 const rule = rules.find(r => r.id === 'live-claim')!;
 const claim = call('slack_send',{text:'Já está no ar (versão 91d8e16).'});
 assert.equal(detect(rule, claim), true);
 assert.equal(detect(rule, call('slack_send',{text:'No ar às 10:52. Não testei a troca de conta em produção.'})), false);
 assert.equal(detect(rule, claim, {active:false,directWork:0,checked:true}), false);
 assert.equal(detect(rule, {type:'message',timestamp:'2026-11-14T00:00:00Z',message:{role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',name:'bash',arguments:{command:'curl -sI https://dentai.com.br'}},{type:'toolCall',name:'slack_send',arguments:{text:'No ar: confirmado.'}}]}}), false);
 const dir = mkdtempSync(join(tmpdir(), 'live-claim-')); try {
  const user = (s: string) => ({type:'message',timestamp:'2026-11-14T00:00:00Z',message:{role:'user',content:[{type:'text',text:s}]}});
  const events = [user('deploy'), call('bash',{command:'gh run view 1'}), claim, user('outra'), claim];
  writeFileSync(join(dir,'s.jsonl'), events.map(e=>JSON.stringify(e)).join('\n'));
  assert.equal(scanCorrections(dir, Date.parse('2026-11-13'), Date.parse('2026-11-15')).find(r=>r.id==='live-claim')!.count, 1);
 } finally { rmSync(dir,{recursive:true,force:true}); }
});
test('suite-repeat flags a second full suite in one run, not focused tests or a new run', () => {
 const suite = call('bash', { command: 'cd ~/projetos/pi-optchat && npm test 2>&1 | tail -5' });
 const verify = call('bash', { command: 'npm run verify > /tmp/v.log 2>&1; echo rc=$?' });
 const focused = call('bash', { command: 'node --test test/heartbeat.test.ts' });
 assert.equal(ruleCount('suite-repeat', [operator, suite, verify]), 1);
 assert.equal(ruleCount('suite-repeat', [operator, suite, focused, focused]), 0, 'focused tests are the cheap check');
 assert.equal(ruleCount('suite-repeat', [operator, suite, operator, verify]), 0, 'a new order starts a new run');
 assert.equal(ruleCount('suite-repeat', [operator, call('bash', { command: 'node --test "test/*.test.ts"' }), suite]), 1);
});
