// 03/11 GX18MCP 4.3.0 release: the operator ordered a release, then had to ask "não é ok suficiente?" three times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EffectApprovals, touchesContract } from '../src/authorization.ts';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import { fromRecords } from '../src/closed-conflicts.ts';

const user = (text: string) => ({ type: 'message', message: { role: 'user', content: text } });

test('reading the contract is not changing it', () => {
  const file = 'C:/Users/x/.optchat/profiles/p/autonomy.json';
  assert.equal(touchesContract({ tool: 'read_many', input: { files: [{ path: file }] } }), false);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `find ~/.optchat -maxdepth 3 -name "autonomy.json" 2>/dev/null` } }), false);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `sed -n 1,20p ${file}` } }), false);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `node --import tsx -e "JSON.parse(require('fs').readFileSync('${file}','utf8'))"` } }), false);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `node --import tsx -e "require('fs').writeFileSync('${file}','{}')"` } }), true);
  assert.equal(touchesContract({ tool: 'codemode', input: { code: `await tools.bash({command:"cat ${file}"})` } }), false);
  // Staging and committing a copy only records it (03/11: the dotfiles mirror commit waited for an approval).
  const mirror = 'C:/projetos/dotfiles/payload/pi/optchat/p/autonomy.json';
  assert.equal(touchesContract({ tool: 'bash', input: { command: `cd C:/projetos/dotfiles && git add ${mirror} && git commit -q -m "espelho" && git push origin main` } }), false);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `git -C C:/projetos/dotfiles add payload/pi/optchat/p/autonomy.json` } }), false);
  // ship.mjs commits and queues a PR like git does: a commit message that names the file only tells about it (04/11: 3 refusals).
  assert.equal(touchesContract({ tool: 'bash', input: { command: `cd C:/projetos/pi-optchat && node scripts/ship.mjs -m "Retro: ajusta o autonomy.json fora das regras protegidas" --all` } }), false);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `node C:/projetos/pi-optchat/scripts/ship.mjs --pr 5 --body-file autonomy.json` } }), false);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `cp x ${file} && node scripts/ship.mjs -m "espelho"` } }), true);
  // Writers still wait for the operator.
  assert.equal(touchesContract({ tool: 'bash', input: { command: `git checkout -- ${file}` } }), true);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `git add ${mirror} && cp x ${file}` } }), true);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `find ~/.optchat -name autonomy.json -delete` } }), true);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `sed -i s/a/b/ ${file}` } }), true);
  assert.equal(touchesContract({ tool: 'codemode', input: { code: `await tools.bash({command:"cp x ${file}"})` } }), true);
  assert.equal(touchesContract({ tool: 'codemode', input: { code: `const c="${file}"; await tools.bash({command:cmd})` } }), true);
  assert.equal(touchesContract({ tool: 'codemode', input: { code: `await tools.write({path:"${file}",content:"{}"})` } }), true);
});

test('a read-only command substitution naming the contract only reads it (04/11: grep of autonomy.json refused)', () => {
  const file = 'C:/Users/x/.optchat/profiles/p/autonomy.json';
  const writes = (command: string) => touchesContract({ tool: 'bash', input: { command } });
  assert.equal(writes(`f=$(ls ${file} ~/.optchat/autonomy.json 2>/dev/null | head -1); echo "$f"; grep -n -i "deploy" "$f" | cut -c1-300 | head`), false);
  assert.equal(writes(`n=\`wc -l < ${file}\`; echo $n`), false);
  // The variable carries the file name: what a later segment does with it is judged as if it named the file.
  assert.equal(writes(`f=$(ls ${file}); echo '{}' > "$f"`), true);
  assert.equal(writes(`f=$(ls ${file}); sed -i s/a/b/ \${f}`), true);
  assert.equal(writes(`x=$(cp y ${file})`), true);
  assert.equal(writes(`x=$(cat $(ls ${file}))`), true);
});

// 11/11: `cp <live profile>/autonomy.json <dotfiles mirror>/autonomy.json` was refused: both paths name the file, but it
// only reads the live one. Only a write whose target is the live contract changes it.
test('copying or printing the live contract into another path is not changing it; a write onto the live file is', () => {
  const live = join(tmpdir(), 'optchat-profile-p'), liveFile = `${live}/autonomy.json`.replaceAll('\\', '/');
  const mirror = 'C:/projetos/dotfiles/payload/pi/optchat/p/autonomy.json';
  const writes = (command: string) => touchesContract({ tool: 'bash', input: { command } }, live);
  for (const command of [`cp ${liveFile} ${mirror}`, `cp -f "${liveFile}" "${mirror}"`, `cat ${liveFile} > ${mirror}`, `Copy-Item ${liveFile} ${mirror}`, `cp ~/.optchat/profiles/p/autonomy.json ${mirror}`])
    assert.equal(writes(command), false, command);
  for (const command of [`cp ${mirror} ${liveFile}`, `cat ${mirror} > ${liveFile}`, `echo '{}' >> "${live}\\autonomy.json"`, `sed -i s/a/b/ ${liveFile}`])
    assert.equal(writes(command), true, command);
  assert.equal(touchesContract({ tool: 'write', input: { path: mirror, content: '{}' } }, live), false);
  assert.equal(touchesContract({ tool: 'write', input: { path: liveFile, content: '{}' } }, live), true);
  assert.equal(touchesContract({ tool: 'codemode', input: { code: `await tools.bash({ command: 'cp ${liveFile} ${mirror}' })` } }, live), false);
  assert.equal(touchesContract({ tool: 'bash', input: { command: `cp ${liveFile} ${mirror}` } }), true, 'without a profile folder to compare, a copy naming the file stays gated');
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
  assert.equal(await call('npm run build'), undefined, 'a harmless call in between');
  assert.deepEqual(announced, []);
  hooks.get('agent_end')!({ messages: [] }, ctx);
  assert.equal(announced.length, 1, 'still waiting at the end of the run: announced once');
  assert.match(announced[0], /--delete/);
  assert.equal((await call('git push --force origin main')).block, true);
  hooks.get('agent_end')!({ messages: [] }, ctx);
  assert.equal(announced.length, 2, 'a call that arrives later waits for its own run end');
  assert.match(announced[1], /--force/);
  hooks.get('agent_end')!({ messages: [] }, ctx);
  assert.equal(announced.length, 2, 'each is announced once');
  await hooks.get('session_shutdown')!({}, ctx);
});

test('a JSON "\\b" (backspace) in a closed-conflict pattern is refused, not silently never matched', () => {
  assert.throws(() => fromRecords([{ id: 'x', match: 'a', with: '\bvs\b', say: 's' }]), /control character/);
  assert.equal(fromRecords([{ id: 'x', match: '(?<!\\d)100322(?!\\d)', with: '\\bvs\\b', say: 's' }])[0].cites('100322 vs 99638'), true);
});
