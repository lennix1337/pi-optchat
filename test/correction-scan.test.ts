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
];
for (const [id, yes, no] of cases) test(`detector ${id} distinguishes fixtures`, () => {
 const rule = rules.find(r => r.id === id)!; assert.ok(rule); assert.equal(detect(rule, yes), true); assert.equal(detect(rule, no), false);
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
