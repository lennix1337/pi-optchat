import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShellJobs, adoptShells, alertReport, endNoticeWanted, handOffShells, registerShells, runningShells, shellReport, type ShellJob } from '../src/shells.ts';
import { OutputAlerts, alertLabel, alertPattern, type ShellAlert } from '../src/shell-alerts.ts';
import { Check } from 'typebox/value';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

test('foreground inventory streams bounded output, records failure and refuses individual stop', () => {
  const jobs = new ShellJobs(); let changes = 0;
  const unsubscribe = jobs.subscribe(() => changes++);
  jobs.begin('call', 'echo hello', '/project', 'foreground');
  jobs.update('call', 'x'.repeat(40_000));
  assert.match(jobs.list()[0].output, /^\[Earlier output omitted\]/);
  assert.ok(jobs.list()[0].output.length < 32_100);
  assert.equal(jobs.stop('call'), false);
  jobs.end('call', 'bad exit', true);
  assert.equal(jobs.list()[0].state, 'failed');
  assert.ok(jobs.list()[0].ended);
  jobs.end('call', 'duplicate', false);
  assert.equal(jobs.list()[0].output, 'bad exit');
  unsubscribe(); assert.ok(changes >= 4);
});

test('managed jobs return immediately, stop independently and close waits for cleanup', async () => {
  const jobs = new ShellJobs();
  const run = (command: string) => jobs.start(command, '/project', async (signal, update) => {
    update('started');
    await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    return { output: 'closed', failed: false };
  });
  const a = run('server A'), b = run('server B');
  await Promise.resolve();
  assert.equal(jobs.stop(a), true);
  assert.equal(jobs.stop(a), false);
  assert.equal(jobs.list().find(j => j.id === b)?.state, 'running');
  await jobs.close();
  assert.ok(jobs.list().every(j => j.state === 'stopped'));
  assert.ok(jobs.list().every(j => j.ended));
});

test('stopping a queued managed job prevents execution and reports its stop once', async () => {
  const jobs = new ShellJobs(), reports: string[] = [];
  let executions = 0;
  jobs.setReporter({ finished: job => reports.push(job.state), alerted() {} });
  const id = jobs.start('queued effect', '/project', async () => {
    executions++;
    return { output: 'effect executed', failed: false };
  });
  assert.equal(jobs.stop(id), true);
  await jobs.close();
  assert.equal(executions, 0, 'cancellation before dispatch must prevent the effect, not merely label it stopped');
  assert.equal(jobs.list()[0].state, 'stopped');
  assert.deepEqual(reports, ['stopped']);
  assert.equal(jobs.stop(id), false);
  await jobs.close();
  assert.deepEqual(reports, ['stopped'], 'repeated close must not report again');
});

test('closing immediately prevents every queued executor from starting', async () => {
  const jobs = new ShellJobs();
  let executions = 0;
  for (let i = 0; i < 3; i++) jobs.start(`queued ${i}`, '/project', async () => {
    executions++;
    return { output: 'effect executed', failed: false };
  });
  await jobs.close();
  assert.equal(executions, 0);
  assert.ok(jobs.list().every(job => job.state === 'stopped' && job.ended !== undefined));
});

test('managed background captures successful and rejected execution without unhandled rejection', async () => {
  const jobs = new ShellJobs();
  jobs.start('ok', '.', async () => ({ output: 'done', failed: false }));
  jobs.start('bad', '.', async () => { throw new Error('failure'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.list().find(j => j.command === 'ok')?.state, 'completed');
  assert.equal(jobs.list().find(j => j.command === 'bad')?.state, 'failed');
  await jobs.close();
});

test('shell events include nested Code Mode calls and ignore non-shell tools', () => {
  const jobs = new ShellJobs(), events = new Map<string, (event: any, ctx?: any) => void>();
  registerShells({ on: (name: string, handler: any) => events.set(name, handler), registerTool() {} } as unknown as ExtensionAPI, jobs);
  events.get('tool_execution_start')?.({ toolName: 'bash', toolCallId: 'nested', parentToolCallId: 'code', args: { command: 'echo yes' } }, { cwd: '.' });
  events.get('tool_execution_update')?.({ toolName: 'bash', toolCallId: 'nested', partialResult: { content: [{ type: 'text', text: 'yes' }] } });
  events.get('tool_execution_end')?.({ toolName: 'bash', toolCallId: 'nested', result: { content: [{ type: 'text', text: 'yes' }] }, isError: false });
  events.get('tool_execution_start')?.({ toolName: 'read', toolCallId: 'read', args: {} }, { cwd: '.' });
  assert.equal(jobs.list().length, 1);
  assert.equal(jobs.list()[0].state, 'completed');
});

test('native background command streams output and cancellation terminates its shell process', { timeout: 15_000 }, async () => {
  const jobs = new ShellJobs(), tools = new Map<string, any>();
  registerShells({ on() {}, registerTool: (tool: any) => tools.set(tool.name, tool) } as unknown as ExtensionAPI, jobs);
  const started = await tools.get('shell_start').execute('start', { command: 'node -e "console.log(process.pid); setInterval(() => {}, 1000)"', timeout: 10 }, undefined, undefined, { cwd: process.cwd() });
  const id = started.details.id;
  try {
    const deadline = Date.now() + 5_000;
    while (!/^\d+/m.test(jobs.list()[0].output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    const pid = Number(jobs.list()[0].output.match(/^\d+/m)?.[0]);
    assert.ok(pid > 0, 'real child streamed its PID');
    assert.equal(jobs.stop(id), true);
    await jobs.close();
    assert.equal(jobs.list()[0].state, 'stopped');
    assert.throws(() => process.kill(pid, 0), 'native cancellation must terminate the child, not only mark the UI stopped');
  } finally { await jobs.close(); }
});

test('a handed-off shell keeps running, its end waits for the next reporter, and the handoff is taken once', async () => {
  const jobs = new ShellJobs(), first: string[] = [], second: string[] = [];
  jobs.setReporter({ finished: job => first.push(job.id), alerted() {} });
  let finish!: () => void;
  const id = jobs.start('node build.js', '.', () => new Promise(resolve => { finish = () => resolve({ output: 'built', failed: false, exitCode: 0 }); }));
  await new Promise(resolve => setImmediate(resolve));
  handOffShells(jobs, 'main');
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(jobs.list()[0].state, 'completed', 'the handoff did not stop it');
  assert.deepEqual(first, [], 'the closing profile no longer hears from it');
  const adopted = adoptShells();
  assert.equal(adopted?.jobs, jobs); assert.equal(adopted?.profile, 'main');
  assert.equal(adoptShells(), undefined, 'a second load does not adopt the same shells');
  adopted.jobs.setReporter({ finished: job => second.push(job.id), alerted() {} });
  adopted.jobs.setReporter({ finished: job => second.push(job.id), alerted() {} });
  assert.deepEqual(second, [id], 'the held end is delivered once, to the reloaded profile');
  await jobs.close();
});

test('retention bounds finished history without dropping active executions', () => {
  const jobs = new ShellJobs(); jobs.begin('active', 'server', '.', 'foreground');
  for (let i = 0; i < 70; i++) { jobs.begin(`job-${i}`, 'echo', '.', 'foreground'); jobs.end(`job-${i}`, 'done', false); }
  assert.equal(jobs.list().length, 51);
  assert.equal(jobs.list()[0].id, 'active');
  assert.ok(jobs.list().some(j => j.id === 'job-69'));
  assert.ok(!jobs.list().some(j => j.id === 'job-0'));
});

test('a managed background shell reports its end once, with state, exit code and log; foreground calls never do', async () => {
  const jobs = new ShellJobs(), reports: { id: string; state: string; exitCode?: number; log?: string; output: string }[] = [];
  jobs.setReporter({ finished: job => reports.push({ id: job.id, state: job.state, exitCode: job.exitCode, log: job.log, output: job.output }), alerted() {} });
  jobs.begin('fg', 'echo', '.', 'foreground'); jobs.end('fg', 'done', false);
  assert.deepEqual(reports, [], 'Pi already shows a foreground bash result');
  const id = jobs.start('node build.js', '.', async (_signal, update) => {
    update('compiling', 'C:/tmp/full-build.log');
    return { output: 'compiling\nFAIL module x', failed: true, exitCode: 3, log: 'C:/tmp/full-build.log' };
  });
  await new Promise(resolve => setImmediate(resolve)); // a job that finishes on its own is not stopped by close()
  await jobs.close();
  assert.deepEqual(reports, [{ id, state: 'failed', exitCode: 3, log: 'C:/tmp/full-build.log', output: 'compiling\nFAIL module x' }]);
  jobs.end(id, 'again', false);
  assert.equal(reports.length, 1, 'an ended job never reports twice');
});

test('a stopped shell reports as stopped once, and a shell that throws reports its reason as failed', async () => {
  const jobs = new ShellJobs(), reports: { command: string; state: string; output: string }[] = [];
  jobs.setReporter({ finished: job => reports.push({ command: job.command, state: job.state, output: job.output }), alerted() {} });
  const server = jobs.start('node server.js', '.', (signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ output: 'Command aborted', failed: true }), { once: true });
  }));
  await Promise.resolve();
  assert.equal(jobs.stop(server), true);
  jobs.start('node slow.js', '.', async () => { throw new Error('Command timed out after 1 seconds'); });
  await new Promise(resolve => setImmediate(resolve));
  await jobs.close();
  assert.deepEqual(reports.map(r => [r.command, r.state]), [['node server.js', 'stopped'], ['node slow.js', 'failed']]);
  assert.match(reports[1].output, /timed out after 1 seconds$/);
});

test('the report to the model names the shell, its outcome and command, and carries only a bounded end of its output', () => {
  const lines = Array.from({ length: 5_000 }, (_, i) => `line ${i}`);
  const job: ShellJob = { id: 'sh-1', command: 'node build.js ' + 'x'.repeat(1_000), cwd: '.', mode: 'background', state: 'completed',
    started: Date.now() - 12_400, ended: Date.now(), output: lines.join('\n') + '\nfinal line', exitCode: 0, log: 'C:/tmp/pi-bash-full.log', notify: 'end' };
  const text = shellReport(job);
  assert.match(text, /^\[shell sh-1\] completed · exit 0 · ran 12\.\ds\n/);
  assert.ok(text.includes('Command: node build.js xxx'), 'the command is named');
  assert.ok(!text.includes('x'.repeat(400)), 'a long command is cut');
  assert.ok(text.includes('final line'), 'the end of the output is kept');
  assert.ok(!text.includes('line 100\n'), 'older output is left out');
  assert.ok(text.length < 4_500, `the report stays bounded (${text.length} characters)`);
  assert.match(text, /Full output: C:\/tmp\/pi-bash-full\.log/);
  assert.match(text, /do not poll|no polling/i, 'the model is told not to poll');
  const quiet = shellReport({ ...job, state: 'stopped', exitCode: undefined, log: undefined, output: '' });
  assert.match(quiet, /^\[shell sh-1\] stopped · ran /);
  assert.match(quiet, /\(no output\)/);
  assert.match(quiet, /Full output: not kept/);
});

test('the status line lists only background shells still running', () => {
  const jobs = new ShellJobs();
  jobs.begin('fg', 'echo', '.', 'foreground');
  jobs.begin('running', 'node server.js', '.', 'background');
  jobs.begin('done', 'node build.js', '.', 'background'); jobs.end('done', 'ok', false);
  assert.deepEqual(runningShells(jobs).map(job => job.id), ['running']);
});
const prng = (seed: number) => () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
/** Feeds `bytes` in random pieces of 1 to 40 bytes, often a single byte, so chunk boundaries fall everywhere. */
function feedRandomly(watch: OutputAlerts, bytes: Buffer, random: () => number) {
  for (let at = 0; at < bytes.length;) {
    const size = random() < 0.2 ? 1 : 1 + Math.floor(random() * 40);
    watch.feed(bytes.subarray(at, at + size));
    at += size;
  }
}
/** A clock the test moves by hand: timers fire in time order as it passes them. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  return {
    now: () => now,
    setTimer(run: () => void, ms: number) {
      const timer = { at: now + ms, run, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const next = timers.filter(t => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers.splice(timers.indexOf(next), 1);
        now = next.at;
        next.run();
      }
      now = target;
    },
  };
}
const shownLines = (alerts: ShellAlert[]) => alerts.flatMap(alert => alert.shown.map(match => match.line));
const fakePi = (tools: Map<string, any>) => ({ on() {}, registerTool: (tool: any) => tools.set(tool.name, tool) }) as unknown as ExtensionAPI;

test('the end notice follows the notify mode: every end, failures only, or none', async () => {
  for (const state of ['completed', 'failed', 'stopped'] as const) {
    assert.equal(endNoticeWanted('end', state), true, `end: ${state}`);
    assert.equal(endNoticeWanted('none', state), false, `none: ${state}`);
    assert.equal(endNoticeWanted('failure', state), state === 'failed', `failure: ${state}`);
  }
  const jobs = new ShellJobs(), ended: string[] = [];
  jobs.setReporter({ finished: job => ended.push(`${job.command}:${job.state}`), alerted() {} });
  jobs.start('ok', '.', async () => ({ output: 'ok', failed: false }), { notify: 'failure' });
  jobs.start('bad', '.', async () => ({ output: 'bad', failed: true, exitCode: 3 }), { notify: 'failure' });
  jobs.start('quiet', '.', async () => ({ output: 'bad', failed: true }), { notify: 'none' });
  await new Promise(resolve => setImmediate(resolve));
  await jobs.close();
  assert.deepEqual(ended, ['bad:failed'], 'a completed or silenced shell sends nothing');
});

test('the end observer sees every managed end once, even a silenced one, and never fails the job', () => {
  const jobs = new ShellJobs(), seen: string[] = [];
  jobs.setEndObserver(job => { seen.push(`${job.id}:${job.state}:${job.exitCode}`); throw new Error('an observer must not break the job'); });
  jobs.begin('quiet', 'echo', '.', 'background', 'main', { notify: 'none' });
  jobs.begin('call', 'echo', '.', 'foreground');
  jobs.end('quiet', '', false, { exitCode: 0 });
  jobs.end('quiet', '', true, { exitCode: 1 });
  jobs.end('call', '', false, { exitCode: 0 });
  assert.deepEqual(seen, ['quiet:completed:0'], 'one observation per background end, whatever its notify mode or a repeat');
  jobs.setEndObserver(undefined);
  jobs.begin('later', 'echo', '.', 'background');
  jobs.end('later', '', false, { exitCode: 0 });
  assert.deepEqual(seen, ['quiet:completed:0']);
});

test('shell_start takes notify and alert, uses the profile default when notify is omitted, and refuses a bad pattern before starting', async () => {
  const jobs = new ShellJobs(), tools = new Map<string, any>();
  registerShells(fakePi(tools), jobs, () => {}, { notifyDefault: () => 'failure' });
  const start = tools.get('shell_start');
  assert.equal(Check(start.parameters, { command: 'x', notify: 'sometimes' }), false, 'notify is end, failure or none');
  assert.equal(Check(start.parameters, { command: 'x', notify: 'none', alert: 'MATCH' }), true);
  await assert.rejects(start.execute('bad', { command: 'node -e 0', alert: '(' }, undefined, undefined, { cwd: '.' }), /alert/);
  assert.equal(jobs.list().length, 0, 'nothing started for a bad pattern');
  await start.execute('default', { command: 'node -e 0' }, undefined, undefined, { cwd: '.' });
  await start.execute('explicit', { command: 'node -e 0', notify: 'end' }, undefined, undefined, { cwd: '.' });
  assert.deepEqual(jobs.list().map(job => job.notify).sort(), ['end', 'failure']);
  await jobs.close();
});

test('output alerts see every line exactly once, whatever the chunk boundaries, with CRLF, UTF-8 and case-insensitive matches', () => {
  const lines = Array.from({ length: 4_000 }, (_, i) => i % 9 === 0 ? `café ✓ MATCH ${i + 1} ção 🚀${i % 18 === 0 ? '\r' : ''}` : `plain ${i + 1} naïve${i % 5 === 0 ? '\r' : ''}`);
  const bytes = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const expected = lines.flatMap((line, i) => /match/i.test(line) ? [i + 1] : []);
  for (const seed of [1, 2, 3]) {
    const alerts: ShellAlert[] = [];
    const watch = new OutputAlerts({ pattern: /match/i, intervalMs: 0, onAlert: alert => alerts.push(alert) });
    feedRandomly(watch, bytes, prng(seed));
    watch.end();
    assert.deepEqual(shownLines(alerts), expected, `seed ${seed}: no line missing, none twice`);
    assert.equal(alerts.reduce((sum, alert) => sum + alert.matches, 0), expected.length, 'every match is counted');
    assert.equal(alerts.at(-1)?.total, expected.length);
    assert.equal(alerts[0].shown[0].text, 'café ✓ MATCH 1 ção 🚀', 'UTF-8 is whole and the CR of a CRLF line is not part of the text');
  }
});

test('a match or a line split across chunks is found once, and feeding byte by byte finds the same lines', () => {
  const run = (chunks: Buffer[]) => {
    const alerts: ShellAlert[] = [];
    const watch = new OutputAlerts({ pattern: /MERGED/, intervalMs: 0, onAlert: alert => alerts.push(alert) });
    for (const chunk of chunks) watch.feed(chunk);
    watch.end();
    return alerts;
  };
  const text = 'start\nMERGED #610 into main\nend without newline MERGED';
  const split = run([Buffer.from('start\nMER'), Buffer.from('GED #610 into main\nend without newline MER'), Buffer.from('GED')]);
  assert.deepEqual(shownLines(split), [2, 3], 'the match cut in two is found, on its own line each time');
  const bytewise = run(Array.from(Buffer.from(text), byte => Buffer.from([byte])));
  assert.deepEqual(shownLines(bytewise), shownLines(run([Buffer.from(text)])), 'byte by byte finds the same lines');
  assert.equal(split.at(-1)?.total, 2, 'a last line without a newline is counted when the stream ends');
});

test('a line longer than 64 KiB is scanned in pieces: a match in a later piece is found once, and no character is split', () => {
  const alerts: ShellAlert[] = [];
  const watch = new OutputAlerts({ pattern: /MATCH/, intervalMs: 0, onAlert: alert => alerts.push(alert) });
  watch.feed(Buffer.from('x'.repeat(150_000) + ' MATCH\nnext line\n'));
  watch.feed(Buffer.from('a' + 'é'.repeat(40_000) + ' MATCH\n'));
  watch.end();
  assert.deepEqual(shownLines(alerts), [1, 3], 'each line is counted once, whichever piece holds the match (line 2 has none)');
  assert.equal(alerts.at(-1)?.total, 2);
  assert.ok(alerts.every(alert => alert.shown.every(match => !match.text.includes('\uFFFD'))), 'no character is cut in two');
  assert.ok(alerts[0].shown[0].text.includes('MATCH'), 'the excerpt is centred on the match, not on the start of the line');
  // Pieces that all match still count the line once; and a character cut in two would show up as a replacement character when scanned.
  const many: ShellAlert[] = [], x = new OutputAlerts({ pattern: /x/, intervalMs: 0, onAlert: alert => many.push(alert) });
  x.feed(Buffer.from('x'.repeat(150_000) + '\n')); x.end();
  assert.deepEqual(shownLines(many), [1], 'a line whose several pieces match is counted once');
  const broken: ShellAlert[] = [], replacement = new OutputAlerts({ pattern: /\uFFFD/, intervalMs: 0, onAlert: alert => broken.push(alert) });
  replacement.feed(Buffer.from('a' + 'é'.repeat(40_000) + '\n')); replacement.end();
  assert.deepEqual(broken, [], 'no piece of valid UTF-8 is cut inside a character');
});

test('alerts come at most once per interval: a match inside the interval waits, then the waiting ones go out together', () => {
  const clock = fakeClock(), alerts: ShellAlert[] = [];
  const watch = new OutputAlerts({ pattern: /MATCH/, intervalMs: 10_000, now: clock.now, setTimer: clock.setTimer, onAlert: alert => alerts.push(alert) });
  watch.feed(Buffer.from('MATCH 1\n'));
  clock.advance(1_000); watch.feed(Buffer.from('MATCH 2\nMATCH 3\n'));
  clock.advance(2_000); watch.feed(Buffer.from('MATCH 4\n'));
  assert.equal(alerts.length, 1, 'the first match is reported at once');
  clock.advance(6_999); assert.equal(alerts.length, 1, 'still inside the interval');
  clock.advance(1); assert.equal(alerts.length, 2, 'at the end of the interval the three that waited go out together');
  assert.deepEqual(alerts.map(alert => [alert.matches, alert.firstLine, alert.lastLine]), [[1, 1, 1], [3, 2, 4]]);
  clock.advance(5_000); watch.feed(Buffer.from('MATCH 5\n'));
  assert.equal(alerts.length, 2, 'inside the interval again: it waits');
  clock.advance(5_000); assert.equal(alerts.length, 3);
  assert.equal(alerts[2].matches, 1);
  watch.end();
});

test('an alert shows the latest matches with two lines before each, counts the rest, and clips long lines around the match', () => {
  const clock = fakeClock(), alerts: ShellAlert[] = [];
  const watch = new OutputAlerts({ pattern: /MATCH/, intervalMs: 10_000, now: clock.now, setTimer: clock.setTimer, onAlert: alert => alerts.push(alert) });
  watch.feed(Buffer.from('MATCH first\n'));
  for (let i = 1; i <= 12; i++) watch.feed(Buffer.from(`ctx ${i}\nMATCH ${i}\n`));
  clock.advance(10_000);
  const second = alerts[1];
  assert.equal(second.matches, 12);
  assert.equal(second.hidden, 7, 'five are shown, seven are only counted');
  assert.deepEqual(second.shown.map(match => match.line), [17, 19, 21, 23, 25]);
  assert.deepEqual(second.shown[0].before.map(line => line.text), ['MATCH 7', 'ctx 8'], 'the two lines before the match');
  assert.equal(second.total, 13);
  watch.feed(Buffer.from(`MATCH ${'y'.repeat(5_000)}\n`));
  watch.end();
  const long = alerts.at(-1)!.shown[0].text;
  assert.ok([...long].length <= 241 && long.startsWith('MATCH') && long.endsWith('…'), 'a long matched line is clipped');
});

test('ending the shell sends the matches still waiting for the window at once, and cancels the timer', () => {
  const clock = fakeClock(), alerts: ShellAlert[] = [];
  const watch = new OutputAlerts({ pattern: /MATCH/, intervalMs: 10_000, now: clock.now, setTimer: clock.setTimer, onAlert: alert => alerts.push(alert) });
  watch.feed(Buffer.from('MATCH 1\n'));
  watch.feed(Buffer.from('MATCH 2\n'));
  clock.advance(2_000);
  watch.end();
  assert.equal(alerts.length, 2, 'the waiting match goes out at the end');
  assert.equal(alerts[1].matches, 1);
  clock.advance(60_000);
  assert.equal(alerts.length, 2, 'the timer was cancelled');
});

test('alertReport names the pattern, the new matches and their lines, and stays bounded', () => {
  const block = (line: number) => ({ line, text: `MATCH ${'z'.repeat(230)}`, before: [{ line: line - 2, text: 'ctx a' }, { line: line - 1, text: 'ctx b' }] });
  const alert: ShellAlert = { matches: 9, firstLine: 6, lastLine: 30, total: 10, hidden: 4, shown: [6, 12, 18, 24, 30].map(block) };
  const text = alertReport('sh-9', 'MATCH', alert);
  assert.match(text, /^\[shell sh-9\] alert: \/MATCH\/ · 9 new matches on lines 6–30 \(4 not shown\) · 10 so far\n/);
  assert.match(text, /^> 30 \| MATCH z+$/m, 'the matched line is marked');
  assert.match(text, /^  29 \| ctx b$/m, 'the lines before it are indented');
  assert.ok(text.length < 4_000, `bounded (${text.length} characters)`);
  const one: ShellAlert = { matches: 1, firstLine: 4, lastLine: 4, total: 1, hidden: 0, shown: [{ line: 4, text: 'row 4 MATCH', before: [] }] };
  assert.match(alertReport('sh-1', 'MATCH', one), /^\[shell sh-1\] alert: \/MATCH\/ · 1 new match on line 4 · 1 so far\n> 4 \| row 4 MATCH$/);
});

test('the end report says how many alert matches there were', () => {
  const job: ShellJob = { id: 'sh-2', command: 'npm test', cwd: '.', mode: 'background', state: 'completed', started: Date.now() - 1_000, ended: Date.now(), output: 'done',
    exitCode: 0, notify: 'end', alert: 'MATCH', matches: 4 };
  assert.match(shellReport(job), /^Alert \/MATCH\/: 4 matches in total\.$/m);
});

test('through the real bash tool, 3,000 lines with a match on every third reports each of the 1,000 matches once, though the bash output keeps only its tail', { timeout: 60_000 }, async () => {
  const jobs = new ShellJobs(), tools = new Map<string, any>(), alerts: ShellAlert[] = [];
  jobs.setReporter({ finished() {}, alerted: (_job, _text, alert) => alerts.push(alert) });
  registerShells(fakePi(tools), jobs, () => {}, { alertIntervalMs: 0 });
  const command = `node -e "for (let i = 1; i <= 3000; i++) console.log((i % 3 === 0 ? 'MATCH ' : 'plain ') + i)"`;
  await tools.get('shell_start').execute('burst', { command, alert: 'MATCH' }, undefined, undefined, { cwd: process.cwd() });
  const deadline = Date.now() + 50_000;
  while (jobs.list()[0].state === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  await jobs.close();
  assert.equal(jobs.list()[0].matches, 1000, 'every match was counted from the raw stream');
  assert.equal(alerts.reduce((sum, alert) => sum + alert.matches, 0), 1000, 'every match was reported in an alert or counted in one');
  const lines = shownLines(alerts);
  assert.equal(new Set(lines).size, lines.length, 'no matching line is shown twice');
  assert.ok(lines.every(line => line % 3 === 0), 'only matching lines are shown');
  assert.equal(alerts.at(-1)?.total, 1000);
});

test('through the real bash tool, a 60-second window sends the first match at once and the rest together at the end', { timeout: 60_000 }, async () => {
  const jobs = new ShellJobs(), tools = new Map<string, any>(), alerts: ShellAlert[] = [];
  jobs.setReporter({ finished() {}, alerted: (_job, _text, alert) => alerts.push(alert) });
  registerShells(fakePi(tools), jobs, () => {}, { alertIntervalMs: 60_000 });
  const command = `node -e "for (let i = 1; i <= 30; i++) console.log('row ' + i + (i % 3 === 0 ? ' MATCH' : ''))"`;
  await tools.get('shell_start').execute('window', { command, alert: 'MATCH' }, undefined, undefined, { cwd: process.cwd() });
  const deadline = Date.now() + 50_000;
  while (jobs.list()[0].state === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  await jobs.close();
  assert.equal(jobs.list()[0].matches, 10);
  assert.ok(alerts.length <= 2, 'one alert at once, and at most one for the rest when the shell ends');
  assert.equal(alerts.reduce((sum, alert) => sum + alert.matches, 0), 10);
  assert.equal(alerts[0].firstLine, 3, 'the first match goes out at once');
});

test('a match that straddles the 64 KiB piece boundary of a long line is found, and its line is counted once', () => {
  const alerts: ShellAlert[] = [];
  const watch = new OutputAlerts({ pattern: /MERGED/, intervalMs: 0, onAlert: alert => alerts.push(alert) });
  // MERGED spans bytes 65532 to 65537, so the first piece ends after MERG.
  watch.feed(Buffer.from('x'.repeat(65_532) + 'MERGED\n'));
  watch.end();
  assert.deepEqual(shownLines(alerts), [1], 'found across the boundary');
  assert.equal(alerts.reduce((sum, alert) => sum + alert.matches, 0), 1);
});

test('a match that two overlapping pieces both scan is counted once', () => {
  const alerts: ShellAlert[] = [];
  const watch = new OutputAlerts({ pattern: /MERGED/, intervalMs: 0, onAlert: alert => alerts.push(alert) });
  // MERGED lies in the overlap that the second piece scans again.
  watch.feed(Buffer.from('x'.repeat(62_000) + 'MERGED' + 'x'.repeat(5_600) + '\n'));
  watch.end();
  assert.deepEqual(shownLines(alerts), [1]);
  assert.equal(alerts.reduce((sum, alert) => sum + alert.matches, 0), 1);
});

test('a ^ or $ pattern does not match at a piece boundary of a long line that does not match there', () => {
  const matches = (pattern: RegExp, line: string) => {
    const alerts: ShellAlert[] = [];
    const watch = new OutputAlerts({ pattern, intervalMs: 0, onAlert: alert => alerts.push(alert) });
    watch.feed(Buffer.from(line + '\n'));
    watch.end();
    return alerts.reduce((sum, alert) => sum + alert.matches, 0);
  };
  assert.equal(matches(/x$/, 'x'.repeat(150_000) + 'y'), 0, 'the line ends in y, so x$ does not match');
  assert.equal(matches(/^y/, 'x'.repeat(65_536) + 'y' + 'x'.repeat(100)), 0, 'y starts a piece, not the line');
  assert.equal(matches(/^x/, 'x'.repeat(150_000)), 1, 'the line starts with x');
});
test('an alert takes a plain case-sensitive pattern, or /pattern/flags with the flags i, m, s or u, and refuses other flags or a bad pattern', () => {
  assert.equal(alertPattern('MERGED').test('merged'), false, 'plain is case-sensitive');
  assert.equal(alertPattern('MERGED').test('MERGED'), true);
  assert.equal(alertPattern('/merged|fail/i').test('Failed build'), true, 'the literal form takes flags');
  assert.equal(alertPattern('/a.b/s').test('a\nb'), true, 's makes . match a newline');
  assert.equal(alertPattern('/^x$/m').test('y\nx'), true, 'm makes ^ and $ match per line');
  assert.equal(alertPattern('/a/').flags, '', 'no flags given, none taken');
  assert.equal(alertPattern('/abc').test('/abc'), true, 'a leading slash with no closing one is plain text');
  for (const bad of ['/a/q', '/a/g', '/a/y', '/a/ii', '/a/d', '(', '/(/i']) assert.throws(() => alertPattern(bad), /alert/, bad);
  assert.equal(alertLabel('MERGED'), '/MERGED/', 'a plain pattern is shown in slashes');
  assert.equal(alertLabel('/merged|fail/i'), '/merged|fail/i', 'a literal is shown as written');
});

test('shell_start accepts a /pattern/flags alert and refuses bad flags before starting anything', async () => {
  const jobs = new ShellJobs(), tools = new Map<string, any>();
  registerShells(fakePi(tools), jobs, () => {}, {});
  const start = tools.get('shell_start');
  assert.equal(Check(start.parameters, { command: 'x', alert: '/merged|fail/i' }), true);
  await assert.rejects(start.execute('flags', { command: 'node -e 0', alert: '/merged/q' }, undefined, undefined, { cwd: '.' }), /flags/);
  assert.equal(jobs.list().length, 0, 'nothing started for bad flags');
  await start.execute('literal', { command: 'node -e 0', alert: '/merged|fail/i' }, undefined, undefined, { cwd: '.' });
  assert.equal(jobs.list()[0].alert, '/merged|fail/i');
  await jobs.close();
});

test('a literal alert is named as written in its messages, and a plain one in slashes', () => {
  const alert: ShellAlert = { matches: 1, firstLine: 2, lastLine: 2, total: 1, hidden: 0, shown: [{ line: 2, text: 'Failed build', before: [] }] };
  assert.match(alertReport('sh-3', '/merged|fail/i', alert), /^\[shell sh-3\] alert: \/merged\|fail\/i · 1 new match on line 2 · 1 so far$/m);
  const job: ShellJob = { id: 'sh-4', command: 'make', cwd: '.', mode: 'background', state: 'completed', started: Date.now() - 1_000, ended: Date.now(), output: 'done',
    exitCode: 0, notify: 'end', alert: '/merged|fail/i', matches: 1 };
  assert.match(shellReport(job), /^Alert \/merged\|fail\/i: 1 match in total\.$/m);
});

test('a shell whose own exit is 0 but whose output reports a non-zero inner exit is failed and says so', () => {
  const jobs = new ShellJobs();
  const id = jobs.start('build; echo build_exit=$?', '/project', async () => ({ output: 'compiling\nbuild_exit=1\ngates_exit=0', failed: false, exitCode: 0 }), { notify: 'failure' });
  return new Promise<void>(resolve => setImmediate(() => setImmediate(() => {
    const job = jobs.list().find(j => j.id === id)!;
    assert.equal(job.state, 'failed');
    assert.match(shellReport(job), /^Inner exit codes: build_exit=1 \(the shell itself exited 0\)$/m);
    resolve();
  })));
});

test('inner exit markers of zero or unrelated names do not fail a shell', () => {
  const jobs = new ShellJobs();
  jobs.begin('ok', 'x', '/p', 'background');
  jobs.end('ok', 'build_exit=0\nretries=2\nexit code was 1', false, { exitCode: 0 });
  const job = jobs.list()[0];
  assert.equal(job.state, 'completed');
  assert.doesNotMatch(shellReport(job), /Inner exit codes/);
});

test('terminal escape sequences in shell output never reach the report, so colours cannot leak into the TUI', () => {
  const esc = '\u001b';
  const output = `${esc}[34mEstablishing trust${esc}[39m ${esc}[48;5;0mbg${esc}[0m ${esc}]8;;https://x${esc}\\link${esc}]8;;${esc}\\ done`;
  const job: ShellJob = { id: 'sh-2', command: 'npm trust', cwd: '.', mode: 'background', state: 'completed', started: Date.now(), ended: Date.now(), output, exitCode: 0, notify: 'end' };
  const text = shellReport(job);
  assert.ok(!text.includes(esc), 'no ESC byte in the report');
  assert.ok(text.includes('Establishing trust bg link done'));
  const alert = alertReport('sh-2', 'x', { matches: 1, total: 1, hidden: 0, firstLine: 1, lastLine: 1, shown: [{ line: 1, text: `${esc}[31mx${esc}[0m`, before: [] }] } as ShellAlert);
  assert.ok(!alert.includes(esc));
});
