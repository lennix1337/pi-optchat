import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { buildRemoteScript, checkHost, classifySshFailure, exitCode, judge, parseArgs, parseRemote, render, sshArgs } from '../scripts/prod-check.mjs';
import type { SshRun } from '../scripts/prod-check.mjs';

const prom = (rows: [string, string, string][]) => JSON.stringify({ status: 'success', data: { resultType: 'vector', result: rows.map(([job, instance, value]) => ({ metric: { job, instance }, value: [1794349524.2, value] })) } });

interface Fixture { containers?: string[]; disk?: string[]; nginx?: string; ttfb?: string[]; success?: [string, string, string][]; duration?: [string, string, string][]; mem?: string; skip?: string[] }
const remote = (f: Fixture = {}) => [
  'UPTIME 0.13 0.14 0.16 1386000',
  `MEM ${f.mem ?? '16000000 10000000'}`,
  ...(f.disk ?? ['DISK / 15%', 'DISK /boot/efi 1%']).map((d) => d),
  ...(f.containers ?? [
    'CONTAINER dentai-back|Up 30 hours (healthy)|ghcr.io/tecnologia-ai/dentai-outsourcingti/nest-api:sha-6173020',
    'CONTAINER dentai-front|Up 24 hours (healthy)|ghcr.io/tecnologia-ai/dentai-outsourcingti-front/next-app:sha-0bcc5a7',
    'CONTAINER dentai-nginx|Up 2 weeks|nginx:1.30.6',
    'CONTAINER dentai-prometheus|Up 29 hours (healthy)|prom/prometheus:v3.5.0',
    'CONTAINER strapi|Exited (1) 2 weeks ago|strapi:latest',
  ]),
  'STATS dentai-back|1.20%|300MiB / 7.5GiB',
  'STATS dentai-loki|0.56%|88.4MiB / 7.5GiB',
  f.nginx ?? 'NGINX total=270 2xx=261 3xx=8 4xx=1 5xx=0',
  'TLS TLSv1.3 267',
  'TLS TLSv1.2 3',
  ...(f.ttfb ?? ['TTFB 0.294 200', 'TTFB 0.296 200', 'TTFB 0.162 200']),
  `PROM probe_success ${prom(f.success ?? [['blackbox-slots', 'http://dentai-back:3333/health/ready', '1'], ['blackbox-public', 'https://api.dentai.com.br/health', '1']])}`,
  `PROM probe_duration_seconds ${prom(f.duration ?? [['blackbox-slots', 'http://dentai-back:3333/health/ready', '0.0033'], ['blackbox-public', 'https://api.dentai.com.br/health', '0.46']])}`,
  ...(f.skip ?? []).map((s) => `SKIP ${s}`),
  'END',
].join('\n');

const ok = (stdout: string): SshRun => ({ code: 0, stdout, stderr: '' });
const hostWith = (fixture: Fixture) => checkHost('hetzner-dentai', { sinceMin: 10 }, async () => ok(remote(fixture)), () => 0);

test('a healthy host: no problems, rc 0, a stale exited container from weeks ago is not one', async () => {
  const r = await hostWith({});
  assert.equal(r.status, 'healthy');
  assert.deepEqual(r.problems, []);
  assert.equal(exitCode([r]), 0);
  const text = render([r]);
  assert.match(text, /^host: hetzner-dentai\nstatus: healthy\n/);
  assert.match(text, /problems: none\nrc: 0\n$/);
  assert.match(text, /images: .*nest-api:sha-6173020 \(back\)/);
  assert.match(text, /nginx_10min: 270 requests, 2xx 261, 3xx 8, 4xx 1, 5xx 0/);
  assert.match(text, /tls: TLSv1\.3 267, TLSv1\.2 3/);
  assert.match(text, /origin_ttfb_ms: 294 /);
  assert.match(text, /probes: 2 up of 2, slowest 460 ms/);
  assert.ok(text.trimEnd().split('\n').length <= 30);
});

test('unhealthy, restarting and recently crashed containers are problems', async () => {
  const r = await hostWith({ containers: [
    'CONTAINER dentai-back|Up 3 hours (unhealthy)|ghcr.io/x/nest-api:sha-1',
    'CONTAINER dentai-front|Restarting (1) 5 seconds ago|ghcr.io/x/next-app:sha-2',
    'CONTAINER dentai-worker|Exited (137) 2 hours ago|ghcr.io/x/nest-api:sha-1',
    'CONTAINER dentai-ok|Up 3 hours (health: starting)|redis:7-alpine',
  ] });
  assert.equal(r.status, 'problems');
  assert.deepEqual(r.problems, ['container dentai-back unhealthy', 'container dentai-front restarting', 'container dentai-worker exited (137)']);
  assert.equal(exitCode([r]), 1);
  assert.match(render([r]), /problem_1: container dentai-back unhealthy[\s\S]*rc: 1\n$/);
});

test('a 5xx spike is a problem, a lone 5xx is not', async () => {
  const spike = await hostWith({ nginx: 'NGINX total=200 2xx=170 3xx=5 4xx=5 5xx=20' });
  assert.deepEqual(spike.problems, ['nginx 5xx: 20 of 200 requests']);
  const lone = await hostWith({ nginx: 'NGINX total=200 2xx=190 3xx=5 4xx=4 5xx=1' });
  assert.equal(lone.status, 'healthy');
  const diluted = await hostWith({ nginx: 'NGINX total=100000 2xx=99000 3xx=0 4xx=990 5xx=10' });
  assert.equal(diluted.status, 'healthy');
});

test('a disk above 85% is a problem, 85% itself is not', async () => {
  assert.deepEqual((await hostWith({ disk: ['DISK / 91%', 'DISK /opt 40%'] })).problems, ['disk / at 91%']);
  assert.equal((await hostWith({ disk: ['DISK / 85%'] })).status, 'healthy');
});

test('a probe that is down or slow, and a slow origin TTFB, are problems', async () => {
  const down = await hostWith({ success: [['blackbox-public', 'https://api.dentai.com.br/health', '0'], ['blackbox-slots', 'http://dentai-back:3333/health/ready', '1']] });
  assert.deepEqual(down.problems, ['probe down: blackbox-public https://api.dentai.com.br/health']);
  const slowProbe = await hostWith({ duration: [['blackbox-public', 'https://api.dentai.com.br/health', '4.2'], ['blackbox-slots', 'http://dentai-back:3333/health/ready', '0.01']] });
  assert.deepEqual(slowProbe.problems, ['probe slow: blackbox-public https://api.dentai.com.br/health 4200 ms']);
  const slowOrigin = await hostWith({ ttfb: ['TTFB 1.900 200', 'TTFB 2.100 200', 'TTFB 0.300 200'] });
  assert.deepEqual(slowOrigin.problems, ['origin /health TTFB 1900 ms']);
  const refused = await hostWith({ ttfb: ['TTFB 0.000 000', 'TTFB 0.000 000', 'TTFB 0.000 000'] });
  assert.deepEqual(refused.problems, ['origin /health answered HTTP 0']);
});

test('low memory is a problem; a missing section the host should have is a problem, a skipped one is not', async () => {
  assert.deepEqual((await hostWith({ mem: '16000000 800000' })).problems, ['memory available 5%']);
  const noProm = parseRemote(remote().split('\n').filter((l) => !l.startsWith('PROM')).join('\n'));
  assert.deepEqual(judge(noProm), ['prometheus probes not readable']);
  const noNginx = parseRemote(remote().split('\n').filter((l) => !/^(NGINX|TLS|TTFB)/.test(l)).join('\n'));
  assert.deepEqual(judge(noNginx), ['nginx logs not readable', 'origin TTFB not measured']);
  const bare = await hostWith({ containers: ['CONTAINER other|Up 1 hour|redis:7'], nginx: 'SKIP nginx', ttfb: [], success: [], duration: [], skip: ['prometheus'] });
  assert.equal(bare.status, 'healthy');
  assert.match(render([bare]), /skipped: nginx, prometheus/);
});

test('ssh failures are rc 3 and name the cause without echoing stderr', async () => {
  const fail = (stderr: string, code = 255) => checkHost('hetzner-dentai', {}, async () => ({ code, stdout: '', stderr }), () => 0);
  const changed = await fail('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.');
  assert.equal(changed.status, 'unreachable');
  assert.equal(changed.error, 'host_key_changed');
  assert.equal(exitCode([changed]), 3);
  const text = render([changed]);
  assert.match(text, /^host: hetzner-dentai\nstatus: unreachable\nelapsed_ms: 0\nerror: host_key_changed\nhint: .*\nrc: 3\n$/);
  assert.doesNotMatch(text, /WARNING|@@@/);
  assert.equal((await fail('ssh: connect to host x port 22: Connection timed out')).error, 'unreachable');
  assert.equal((await fail('Permission denied (publickey).')).error, 'auth_failed');
  assert.equal(classifySshFailure('boom', 7).hint, 'ssh exited 7');
  // exit 0 but the remote script never finished: not a healthy answer
  const cut = await checkHost('hetzner-dentai', {}, async () => ok(remote().replace('END', '')), () => 0);
  assert.equal(cut.status, 'unreachable');
  assert.equal(cut.error, 'incomplete_answer');
  const empty = await checkHost('hetzner-dentai', {}, async () => ok(''), () => 0);
  assert.equal(empty.status, 'unreachable');
});

test('exit code: problems win over an unreachable host, unreachable wins over healthy', async () => {
  const healthy = await hostWith({});
  const bad = await hostWith({ disk: ['DISK / 99%'] });
  const down = await checkHost('producao-dentai', {}, async () => ({ code: 255, stdout: '', stderr: 'Connection refused' }), () => 0);
  assert.equal(exitCode([healthy]), 0);
  assert.equal(exitCode([healthy, down]), 3);
  assert.equal(exitCode([down, bad]), 1);
});

test('one ssh session per host: batch mode, timeout, the script on stdin', async () => {
  const calls: { alias: string; script: string }[] = [];
  await checkHost('hetzner-dentai', { sinceMin: 15 }, async (alias, script) => { calls.push({ alias, script }); return ok(remote()); });
  assert.equal(calls.length, 1);
  assert.match(calls[0].script, /^SINCE=15$/m);
  assert.deepEqual(sshArgs('hetzner-dentai'), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'hetzner-dentai', 'sh', '-s']);
  assert.throws(() => sshArgs('-oProxyCommand=x'), /bad host alias/);
  assert.throws(() => sshArgs('a b'), /bad host alias/);
  assert.throws(() => buildRemoteScript(0), /--since/);
  assert.throws(() => buildRemoteScript('10; id' as unknown as number), /--since/);
  const bad = await checkHost('x y', {}, async () => { throw new Error('must not run'); });
  assert.equal(bad.error, 'bad_input');
});

test('the remote script has no write, privilege or lifecycle verbs', () => {
  const script = buildRemoteScript(10);
  const withoutRedirects = script.replace(/2>&1|\d?>\s*\/dev\/null/g, '');
  assert.doesNotMatch(withoutRedirects, />/, 'the only allowed redirects are to /dev/null or 2>&1');
  for (const verb of ['sudo', 'tcpdump', 'compose', 'restart', 'rm', 'tee', 'kill', 'mv', 'cp', 'chmod', 'chown', 'dd', 'up', 'down', 'stop', 'start', 'exec', 'run', 'rmi', 'prune', 'ssh', 'wget']) {
    assert.doesNotMatch(script, new RegExp(`(^|[\\s;|&(])${verb}(?=[\\s;|&)]|$)`, 'm'), `forbidden verb: ${verb}`);
  }
  assert.doesNotMatch(script, /\btee\b|\bsudo\b|docker (compose|restart|stop|start|rm|kill|exec|run|up|down|cp)\b/);
  // every docker call is one of the read verbs
  const docker = [...script.matchAll(/docker (\S+)/g)].map((m) => m[1]).filter((v) => /^[a-z]+$/.test(v)).sort();
  assert.deepEqual([...new Set(docker)], ['logs', 'ps', 'stats']);
});

test('the nginx section prints counts only: no raw line, address, email or path leaves the host', () => {
  const script = buildRemoteScript(10);
  const program = /docker logs [^|]*\| awk '([^']*)'/.exec(script)?.[1];
  assert.ok(program, 'awk program found');
  const lines = [
    '203.0.113.9 - - [10/Nov/2026:19:06:00 +0000] "GET /api/patients/9f3a?email=maria@example.com HTTP/1.1" 200 512 "https://dentai.com.br/x" "Mozilla/5.0" rt=0.010 uct="0.001" uht="0.01" urt="0.01" ua="172.20.0.5:3333" us="200" rl=300 cr=1 ssl=TLSv1.3',
    '203.0.113.10 - - [10/Nov/2026:19:06:01 +0000] "POST /api/login HTTP/2.0" 502 12 "-" "curl/8" rt=0.010 uct="-" uht="-" urt="-" ua="-" us="-" rl=30 cr=2 ssl=TLSv1.2',
    '203.0.113.11 - - [10/Nov/2026:19:06:02 +0000] "GET /missing HTTP/1.1" 404 12 "-" "curl/8" rt=0.010 uct="-" uht="-" urt="-" ua="-" us="-" rl=30 cr=3 ssl=TLSv1.3',
    '2026/11/10 19:06:03 [notice] 1#1: signal process started',
  ].join('\n');
  const ran = spawnSync('awk', [program], { input: lines, encoding: 'utf8' });
  if (ran.error) return; // no awk on this machine: the other tests still cover the script text
  assert.equal(ran.status, 0, ran.stderr);
  const rows = ran.stdout.trim().split('\n').sort();
  assert.deepEqual(rows, ['NGINX total=3 2xx=1 3xx=0 4xx=1 5xx=1', 'TLS TLSv1.2 1', 'TLS TLSv1.3 2']);
  assert.doesNotMatch(ran.stdout, /203\.0|maria|patients|login|Mozilla/);
  const parsed = parseRemote(`${ran.stdout}END`);
  assert.deepEqual(parsed.nginx, { total: 3, c2: 1, c3: 0, c4: 1, c5: 1 });
  assert.deepEqual(parsed.tls, { 'TLSv1.3': 2, 'TLSv1.2': 1 });
});

test('the rendered summary and --json carry the same verdict and no log content', async () => {
  const r = await hostWith({ disk: ['DISK / 99%'] });
  const lines = render([r]).trimEnd().split('\n');
  assert.equal(lines.at(-1), 'rc: 1');
  assert.ok(lines.includes('problem_1: disk / at 99%'));
  assert.deepEqual(parseArgs(['--host', 'all', '--since', '30', '--json']), { hosts: ['hetzner-dentai', 'producao-dentai'], sinceMin: 30, json: true });
  assert.deepEqual(parseArgs([]), { hosts: ['hetzner-dentai'], sinceMin: 10, json: false });
  assert.match(parseArgs(['--since', '0']).error ?? '', /--since/);
  assert.match(parseArgs(['--bogus']).error ?? '', /unknown argument/);
  assert.match(parseArgs(['--host']).error ?? '', /--host/);
});

test('the CLI prints the summary and exits with the verdict', () => {
  const ran = spawnSync(process.execPath, ['scripts/prod-check.mjs', '--since', '0'], { encoding: 'utf8' });
  assert.equal(ran.status, 2);
  assert.match(ran.stdout, /^status: refused\nerror: --since needs whole minutes[^\n]*\nusage: [^\n]*\nrc: 2\n$/);
});
