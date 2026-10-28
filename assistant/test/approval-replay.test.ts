import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, type EffectRequest } from '../src/policy/gateway.ts';

test('two connections consume once, reopen, revoke and bounded rule', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-')); const authority = {}; let now = 100;
  const options = { databasePath: join(dir, 'db'), profileId: 'p', operatorAuthority: authority, now: () => now, policy: () => 'review' as const, inspect: () => ({ decision: 'allow' as const, reasons: [] }) };
  let a = createGateway(options); const b = createGateway(options);
  const r: EffectRequest = { version: 1, operationId: 'o1', profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'mail', action: 'send', account: 'a', destination: 'd', policyVersion: 'v', expiresAt: 200, payload: Buffer.from('hello') };
  try {
    const id = a.prepare(r).reviewId!; a.decide(id, 'approve', authority); let calls = 0;
    const results = await Promise.allSettled([a.dispatch(r, () => { calls++; }), b.dispatch(r, () => { calls++; })]);
    assert.equal(calls, 1); assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    const next = { ...r, operationId: 'o2' }; const revoked = a.prepare(next).reviewId!; a.decide(revoked, 'approve', authority); a.revoke(revoked, authority); await assert.rejects(b.dispatch(next, () => assert.fail()), /approval_required/);
    const rule = a.prepare(next).reviewId!; a.decide(rule, 'approve', authority, { scope: 'rule', uses: 2, expiresAt: 150 });
    a.close(); a = createGateway(options); await assert.rejects(a.dispatch({ ...next, destination: 'other' }, () => assert.fail()), /approval_required/); await a.dispatch(next, () => {}); await b.dispatch({ ...r, operationId: 'o3' }, () => {}); await assert.rejects(a.dispatch({ ...r, operationId: 'o4' }, () => assert.fail()), /approval_required/);
    const expiring = a.prepare({ ...r, operationId: 'o5' }).reviewId!; a.decide(expiring, 'approve', authority, { scope: 'rule', uses: 1, expiresAt: 150 }); now = 150; await assert.rejects(b.dispatch({ ...r, operationId: 'o5' }, () => assert.fail()), /approval_required/);
  } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('independent processes race one grant against a quiescent private database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-race-')); const authority = {}; const db = join(dir, 'db');
  const options = { databasePath: db, profileId: 'p', operatorAuthority: authority, policy: () => 'review' as const, inspect: () => ({ decision: 'allow' as const, reasons: [] }) };
  const gateway = createGateway(options);
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<void>[] = [];
  const r: EffectRequest = { version: 1, operationId: 'o', profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', adapter: 'a', action: 'x', account: 'a', destination: 'd', policyVersion: 'v', expiresAt: Date.now() + 60000, payload: Buffer.from('x') };
  try {
    gateway.decide(gateway.prepare(r).reviewId!, 'approve', authority); gateway.close();
    const script = join(dir, 'race.mjs');
    writeFileSync(script, `import { createGateway } from ${JSON.stringify(new URL('../src/policy/gateway.ts', import.meta.url).href)};\nconst g = createGateway({databasePath: process.argv[2], profileId:'p', operatorAuthority:{}, policy:()=> 'review', inspect:()=>({decision:'allow',reasons:[]})});\nconst r = ${JSON.stringify({ ...r, payload: undefined })}; r.payload = Buffer.from('x');\nprocess.send('ready'); process.on('message', async () => { try { await g.dispatch(r, () => { process.send('sink'); }); process.send('won'); } catch (e) { process.send(e.message); } finally { g.close(); process.disconnect(); } });`);
    const messages: string[][] = [[], []]; let ready = 0;
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, [script, db], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 10000 });
      children.push(child);
      exits.push(new Promise<void>((resolve, reject) => { let stderr = ''; child.stderr!.on('data', data => { stderr += data; }); child.on('error', reject); child.on('message', message => { messages[i].push(String(message)); if (message === 'ready' && ++ready === 2) children.forEach(c => c.send('go')); }); child.on('close', code => code === 0 ? resolve() : reject(new Error(`child_exit_${code}: ${stderr}`))); }));
    }
    await Promise.all(exits); assert.equal(messages.flat().filter(m => m === 'sink').length, 1); assert.equal(messages.flat().filter(m => m === 'won').length, 1); assert.equal(messages.flat().filter(m => m === 'operation_already_dispatched').length, 1);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled(exits);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('disposable mutation of sink-error guard breaks the canary assertion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-mutant-'));
  try {
    // The whole source tree, so a new shared module never turns the mutant into a module-not-found pass.
    cpSync(fileURLToPath(new URL('../src', import.meta.url)), join(dir, 'src'), { recursive: true });
    const src = join(dir, 'src', 'policy'); const tests = join(dir, 'test'); mkdirSync(tests, { recursive: true });
    const gatewayPath = fileURLToPath(new URL('../src/policy/gateway.ts', import.meta.url));
    const source = readFileSync(gatewayPath, 'utf8'); const anchor = "catch { throw new Error('effect_uncertain'); }";
    assert.equal(source.split(anchor).length, 2);
    writeFileSync(join(src, 'gateway.ts'), source.replace(anchor, 'catch (error) { throw error; }'));
    writeFileSync(join(tests, 'gateway.test.ts'), readFileSync(fileURLToPath(new URL('./gateway.test.ts', import.meta.url))));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    const childenv = { ...process.env };
    delete childenv.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', '--test-timeout=15000', join(tests, 'gateway.test.ts')], { encoding: 'utf8', timeout: 20000, env: childenv });
    const output = run.stdout + run.stderr;
    assert.equal(run.error, undefined); assert.equal(run.status, 1, output);
    assert.match(output, /allowed local effect requires no review and failures remain uncertain/);
    assert.match(output, /AssertionError/); assert.match(output, /secret-recipient-payload-canary/); assert.match(output, /effect_uncertain/);
    assert.doesNotMatch(output, /ERR_MODULE|SyntaxError|MODULE_TYPELESS_PACKAGE_JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
