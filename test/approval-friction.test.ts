// 03/11 GX18MCP 4.3.0 release: the operator ordered a release, then had to ask "não é ok suficiente?" three times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { EffectApprovals, touchesContract } from '../src/authorization.ts';
import { operatorWords, recentRequests, registerEffectApprovals } from '../src/authorization-hooks.ts';
import { fromRecords } from '../src/closed-conflicts.ts';
import { openTaskOrders, type Commitment } from '../src/commitments.ts';

const user = (text: string) => ({ type: 'message', message: { role: 'user', content: text } });

test('machine notices are not operator requests, so an order survives a run of gitwatch notices', () => {
  const branch = [
    user('[Slack] pode fazer uma release minor do gx18mcp'),
    ...Array.from({ length: 5 }, (_, i) => user(`[gitwatch] lennix1337/Genexus18MCP 11:3${i}: PR #84${i} merged`)),
    user('[shell 628285a3-aaaa] exited 1'),
    user('[optchat-reload-resume] Native Pi reload completed'),
    user('[Slack] (aprovação) O operador aprovou no celular: git push'),
    user('approve-effect 0123456789abcdef01234567'),
  ];
  const ctx = { sessionManager: { getBranch: () => branch }, ui: {} } as never;
  assert.deepEqual(recentRequests(ctx), ['pode fazer uma release minor do gx18mcp']);
  assert.equal(operatorWords('[Slack #harness] faz o 3'), 'faz o 3');
  assert.equal(operatorWords('termina a release'), 'termina a release');
});

test('an open task carries the operator\'s own words that opened it to the advisor', () => {
  const base = { owner: 'optchat' as const, createdAt: '', updatedAt: '', progressAt: '', notes: [] };
  const items: Commitment[] = [
    { ...base, id: 'c_1', text: 'Release minor do GX18MCP', source: '7', status: 'open' },
    { ...base, id: 'c_2', text: 'Antigo', source: '8', status: 'done' },
    { ...base, id: 'c_3', text: 'Sem fonte', source: 'slack', status: 'waiting_operator' },
  ];
  const memory: Record<string, { kind: string; text: string }> = { 7: { kind: 'user', text: '[Slack] pode fazer' } };
  assert.deepEqual(openTaskOrders(items, id => memory[id]), ['[Slack] pode fazer (task: Release minor do GX18MCP)', 'Sem fonte']);
});

test('reading the contract is not changing it', () => {
  const file = 'C:/Users/x/.optchat/profiles/p/autonomy.json';
  assert.equal(touchesContract({ tool: 'read_many', input: { files: [{ path: file }] } }), false);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `find ~/.optchat -maxdepth 3 -name "autonomy.json" 2>/dev/null` } }), false);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `sed -n 1,20p ${file}` } }), false);
  assert.equal(touchesContract({ tool: 'codemode', input: { code: `await tools.bash({command:"cat ${file}"})` } }), false);
  // Writers still wait for the operator.
  assert.equal(touchesContract({ tool: 'bash', input: { command: `find ~/.optchat -name autonomy.json -delete` } }), true);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `sed -i s/a/b/ ${file}` } }), true);
  assert.equal(touchesContract({ tool: 'codemode', input: { code: `await tools.bash({command:"cp x ${file}"})` } }), true);
  assert.equal(touchesContract({ tool: 'codemode', input: { code: `const c="${file}"; await tools.bash({command:cmd})` } }), true);
  assert.equal(touchesContract({ tool: 'codemode', input: { code: `await tools.write({path:"${file}",content:"{}"})` } }), true);
});

test('gh pr close --delete-branch is judged as the remote push it is', () => {
  const gate = new EffectApprovals({ mode: 'risk' });
  const refusal = gate.admit({ session: 's', cwd: '/r', tool: 'bash', input: { command: 'gh pr close 841 --delete-branch' } });
  assert.match(refusal!.reason, /push effect/);
  assert.equal(gate.admit({ session: 's', cwd: '/r', tool: 'bash', input: { command: 'gh pr close 841 --comment x' } }), undefined);
});

test('the phone hears only of a call still waiting when the run ends', async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  const announced: string[] = [];
  const pi = { on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI;
  registerEffectApprovals(pi, { enabled: true, mode: 'risk', bell: () => {}, onPending: pending => announced.push(pending.summary) });
  const ctx = { cwd: '/r', sessionManager: { getSessionId: () => 's', getBranch: () => [] }, ui: { notify() {} } };
  const call = (command: string) => hooks.get('tool_call')!({ toolName: 'bash', input: { command } }, ctx);
  assert.equal((await call('git push origin --delete candidate/v1')).block, true);
  assert.deepEqual(announced, [], 'not announced while the run goes on');
  assert.equal(await call('npm run build'), undefined, 'another route: the request is withdrawn');
  hooks.get('agent_end')!({ messages: [] }, ctx);
  assert.deepEqual(announced, [], 'a withdrawn request never reaches the phone');
  assert.equal((await call('git push --force origin main')).block, true);
  hooks.get('agent_end')!({ messages: [] }, ctx);
  assert.equal(announced.length, 1, 'still waiting at the end of the run: announced once');
  assert.match(announced[0], /--force/);
  hooks.get('agent_end')!({ messages: [] }, ctx);
  assert.equal(announced.length, 1);
  await hooks.get('session_shutdown')!({}, ctx);
});

test('a JSON "\\b" (backspace) in a closed-conflict pattern is refused, not silently never matched', () => {
  assert.throws(() => fromRecords([{ id: 'x', match: 'a', with: '\bvs\b', say: 's' }]), /control character/);
  assert.equal(fromRecords([{ id: 'x', match: '(?<!\\d)100322(?!\\d)', with: '\\bvs\\b', say: 's' }])[0].cites('100322 vs 99638'), true);
});
