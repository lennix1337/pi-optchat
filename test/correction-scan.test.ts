import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
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
