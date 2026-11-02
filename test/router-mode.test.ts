import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ROUTER_DOC, ROUTER_WITHHELD, routerReport, routerToolSet, syncRouterTools } from '../src/router-mode.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { HANDOFF_MAX_BYTES } from '../src/handoff-envelope.ts';

const profileTools = ['read', 'bash', 'edit', 'write', 'spawn', 'tell', 'shell_start', 'shell_status', 'shell_stop', 'search', 'ripwire', 'zoom', 'date', 'output_read', 'codemode', 'operational_state'];
const registered = [...profileTools, 'browser_harness', 'desktop', 'project_checks', 'memory_recent', 'read_many'];

test('router mode is off by default, so the main agent executes as before', () => {
  assert.equal(DEFAULT_SETTINGS.routerMode, false);
});

test('the router tool set leaves out every execution tool and keeps dispatch, status and reading', () => {
  const on = routerToolSet(profileTools, true, [], registered).active;
  for (const tool of ['bash', 'edit', 'write', 'shell_start', 'codemode']) assert.ok(!on.includes(tool), `${tool} stays out of a router`);
  for (const tool of ['spawn', 'tell', 'shell_status', 'shell_stop', 'read', 'ripwire', 'zoom', 'date', 'output_read', 'operational_state', 'search']) assert.ok(on.includes(tool), `${tool} stays for a router`);
  for (const tool of ROUTER_WITHHELD) assert.ok(!on.includes(tool), `${tool} is withheld`);
});

test('no active set can leave a withheld tool in place while router mode is on', () => {
  let seed = 11;
  const random = (n: number) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  const names = [...new Set([...registered, ...ROUTER_WITHHELD, 'other_tool'])];
  for (let round = 0; round < 200; round++) {
    const active = names.filter(() => random(2) === 1);
    const next = routerToolSet(active, true, [], registered);
    for (const tool of ROUTER_WITHHELD) assert.ok(!next.active.includes(tool), `${tool} in ${next.active.join(',')}`);
    assert.deepEqual(next.active.filter(name => !ROUTER_WITHHELD.includes(name)), active.filter(name => !ROUTER_WITHHELD.includes(name)), 'every other tool is untouched');
  }
});

test('turning router mode off gives back exactly the tools it took, and only the registered ones', () => {
  const on = routerToolSet(profileTools, true, [], registered);
  const off = routerToolSet(on.active, false, on.removed, registered);
  assert.deepEqual([...off.active].sort(), [...profileTools].sort());
  assert.deepEqual(off.removed, []);
  const gone = routerToolSet(on.active, false, [...on.removed, 'retired_tool'], registered);
  assert.ok(!gone.active.includes('retired_tool'), 'a tool no longer registered is not invented back');
  const never = routerToolSet(['read', 'spawn'], false, [], registered);
  assert.deepEqual(never.active, ['read', 'spawn'], 'a tool router mode never took (codemode) is not added when it turns off');
});

test('applying router mode twice changes nothing the second time', () => {
  const once = routerToolSet(profileTools, true, [], registered);
  const twice = routerToolSet(once.active, true, once.removed, registered);
  assert.deepEqual(twice.active, once.active);
  assert.deepEqual(twice.removed, once.removed);
});

function fakePi(active: string[]) {
  const calls: string[][] = [];
  const pi = {
    getActiveTools: () => [...active],
    getAllTools: () => registered.map(name => ({ name })),
    setActiveTools: (names: string[]) => { calls.push(names); active.splice(0, active.length, ...names); },
  } as unknown as ExtensionAPI;
  return { pi, calls, active };
}

test('syncRouterTools applies the set once, and gives the tools back after a /reload in the same process', () => {
  const first = fakePi([...profileTools]);
  syncRouterTools(first.pi, true);
  assert.equal(first.calls.length, 1);
  assert.ok(!first.active.includes('bash'));
  syncRouterTools(first.pi, true);
  assert.equal(first.calls.length, 1, 'already in the router set: no second change');
  // A /reload re-runs the extension with the session's tools, while the taken ones are remembered by the process.
  const reloaded = fakePi([...first.active]);
  syncRouterTools(reloaded.pi, false);
  assert.ok(reloaded.active.includes('bash') && reloaded.active.includes('shell_start'), 'bash and shell_start come back after the reload');
});

test('with router mode off and nothing taken, the session is not touched', () => {
  const session = fakePi([...profileTools]);
  syncRouterTools(session.pi, false);
  assert.equal(session.calls.length, 0);
});

test('the router prompt names the dispatch path and the cap, and a report is bounded with pointers', () => {
  assert.match(ROUTER_DOC, /spawn/);
  assert.ok(ROUTER_DOC.includes(`${HANDOFF_MAX_BYTES} bytes`));
  const long = 'finding '.repeat(5000);
  const text = routerReport({ id: 'run-7', report: long, sessionFile: 'C:/sessions/run-7.jsonl' });
  assert.ok(Buffer.byteLength(text) <= HANDOFF_MAX_BYTES);
  assert.match(text, /^\[handoff run-7\] worker run-7 -> router/);
  assert.match(text, /summary cut: /);
  assert.match(text, /- run: run-7\n- file: C:\/sessions\/run-7\.jsonl/);
  assert.equal(routerReport({ id: 'run-8', report: 'Done.' }), '[handoff run-8] worker run-8 -> router\nsummary:\nDone.\npointers:\n- run: run-8');
});
