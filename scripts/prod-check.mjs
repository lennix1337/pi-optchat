#!/usr/bin/env node
// One read-only look at a DentAI production host: a single ssh session runs a fixed script and prints a ~30 line summary
// (uptime/load, memory, disk, containers with image tag and health, top docker stats, nginx status classes and TLS
// versions for the last N minutes, origin TTFB to /health, Prometheus blackbox probes) and a problems list.
// Usage: node scripts/prod-check.mjs [--host ALIAS[,ALIAS...]|all] [--since MIN] [--json]
// Hosts are ~/.ssh/config aliases: hetzner-dentai (5.161.116.218) is the production host (nginx, app containers, the
// observability stack with Prometheus on 127.0.0.1:9090); producao-dentai (149.36.0.149) is the other known alias.
// Output is a flat `key: value` block per host ending in `rc:`; exit 0 healthy, 1 problems found, 3 could not check
// (ssh failed or the answer was incomplete). Problems win over an unreachable host when both occur.
// The remote script reads only: no sudo, no writes, no docker lifecycle verbs, and nginx logs are only counted.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_HOST = 'hetzner-dentai';
export const KNOWN_HOSTS = ['hetzner-dentai', 'producao-dentai'];
export const DEFAULTS = { sinceMin: 10, disk: 85, memAvailPct: 8, err5xxMin: 5, err5xxShare: 0.02, ttfbSlowMs: 1000, probeSlowMs: 3000, sshTimeoutMs: 60_000 };
const API_HOST = 'api.dentai.com.br';

/** The script sent on stdin to `sh -s`. Only read commands; every `>` is a redirect to /dev/null; no raw log line leaves the host. */
export function buildRemoteScript(sinceMin) {
  const since = Number(sinceMin);
  if (!Number.isInteger(since) || since < 1 || since > 1440) throw new Error('--since must be a whole number of minutes between 1 and 1440');
  return [
    'export LC_ALL=C',
    `SINCE=${since}`,
    'echo "UPTIME $(cut -d\' \' -f1-3 /proc/loadavg) $(cut -d. -f1 /proc/uptime)"',
    'awk \'/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{print "MEM", t, a}\' /proc/meminfo',
    'df -P -x tmpfs -x devtmpfs -x overlay -x squashfs -x efivarfs -x vfat 2>/dev/null | awk \'NR!=1{print "DISK", $6, $5}\'',
    'if [ -n "$(command -v docker 2>/dev/null)" ]; then',
    '  docker ps -a --format \'CONTAINER {{.Names}}|{{.Status}}|{{.Image}}\' 2>/dev/null',
    '  docker stats --no-stream --format \'{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}\' 2>/dev/null | sort -t\'|\' -k2 -rn | head -5 | sed \'s/^/STATS /\'',
    '  if docker ps --format \'{{.Names}}\' 2>/dev/null | grep -qx dentai-nginx; then',
    '    docker logs --since "${SINCE}m" dentai-nginx 2>&1 | awk \'' + [
      'BEGIN{n2=0;n3=0;n4=0;n5=0;total=0}',
      '{ if (match($0, /" [0-9][0-9][0-9] /)) { c=substr($0,RSTART+2,1); total++; if (c=="2") n2++; else if (c=="3") n3++; else if (c=="4") n4++; else if (c=="5") n5++ } }',
      '{ if (match($0, /ssl=[A-Za-z0-9.]+/)) t[substr($0,RSTART+4,RLENGTH-4)]++ }',
      'END{printf "NGINX total=%d 2xx=%d 3xx=%d 4xx=%d 5xx=%d\\n", total, n2, n3, n4, n5; for (k in t) print "TLS", k, t[k]}',
    ].join(' ') + '\'',
    '    for i in 1 2 3; do',
    `      curl -sk -m 10 -o /dev/null --resolve ${API_HOST}:443:127.0.0.1 -w 'TTFB %{time_starttransfer} %{http_code}\\n' https://${API_HOST}/health 2>/dev/null`,
    '    done',
    '  else',
    '    echo "SKIP nginx"',
    '  fi',
    '  if docker ps --format \'{{.Names}}\' 2>/dev/null | grep -qx dentai-prometheus; then',
    '    for q in probe_success probe_duration_seconds; do',
    '      echo "PROM $q $(curl -s -m 5 "http://127.0.0.1:9090/api/v1/query?query=$q" 2>/dev/null | tr -d \'\\n\')"',
    '    done',
    '  else',
    '    echo "SKIP prometheus"',
    '  fi',
    'else',
    '  echo "SKIP docker"',
    'fi',
    'echo END',
    '',
  ].join('\n');
}

/** ssh arguments: one session, never a prompt, the script goes in on stdin. */
export function sshArgs(alias) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) throw new Error(`bad host alias: ${alias}`);
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', alias, 'sh', '-s'];
}

const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : undefined; };

function containerOf(line) {
  const [name = '', status = '', image = ''] = line.split('|');
  const lower = status.toLowerCase();
  const state = lower.startsWith('restarting') ? 'restarting' : lower.startsWith('up') ? 'up' : lower.startsWith('exited') ? 'exited' : lower.startsWith('dead') ? 'dead' : lower.startsWith('paused') ? 'paused' : lower.startsWith('created') ? 'created' : 'other';
  const health = /\(unhealthy\)/.test(lower) ? 'unhealthy' : /\(health: starting\)/.test(lower) ? 'starting' : /\(healthy\)/.test(lower) ? 'healthy' : 'none';
  const exitCode = /^exited \((\d+)\)/.exec(lower)?.[1];
  const tag = image.includes(':') ? image.slice(image.lastIndexOf(':') + 1) : 'latest';
  const short = image.slice(image.lastIndexOf('/') + 1);
  const recent = /ago/.test(lower) && /(second|minute|hour)s?|about an? (hour|minute)|less than/.test(lower);
  return { name, status, recent, image, short: short.includes(':') ? short : `${short}:latest`, tag, state, health, exitCode: exitCode === undefined ? undefined : Number(exitCode) };
}

function promRows(json) {
  try {
    const body = JSON.parse(json);
    if (body?.status !== 'success') return undefined;
    return (body.data?.result ?? []).map((r) => ({ key: `${r.metric?.job ?? '?'} ${r.metric?.instance ?? '?'}`, value: Number(r.value?.[1]) }));
  } catch { return undefined; }
}

/** Remote output (tagged lines) to a plain object. `complete` is true only when the closing END line arrived. */
export function parseRemote(text) {
  const r = { complete: false, load: undefined, uptimeSec: undefined, memTotalKb: undefined, memAvailKb: undefined, disks: [], containers: [], stats: [], nginx: undefined, tls: {}, ttfb: [], probes: undefined, skipped: [], promFailed: false };
  const success = new Map();
  const duration = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const space = line.indexOf(' ');
    const tag = space < 0 ? line : line.slice(0, space);
    const rest = space < 0 ? '' : line.slice(space + 1);
    if (tag === 'END') r.complete = true;
    else if (tag === 'UPTIME') { const p = rest.split(' '); r.load = p.slice(0, 3).map(num); r.uptimeSec = num(p[3]); }
    else if (tag === 'MEM') { const p = rest.split(' '); r.memTotalKb = num(p[0]); r.memAvailKb = num(p[1]); }
    else if (tag === 'DISK') { const p = rest.split(' '); const pct = num((p[1] ?? '').replace('%', '')); if (p[0] && pct !== undefined) r.disks.push({ mount: p[0], pct }); }
    else if (tag === 'CONTAINER') r.containers.push(containerOf(rest));
    else if (tag === 'STATS') { const [name, cpu, mem] = rest.split('|'); r.stats.push({ name, cpu: num((cpu ?? '').replace('%', '')), mem: (mem ?? '').replace(/\s+/g, '') }); }
    else if (tag === 'NGINX') { const m = Object.fromEntries([...rest.matchAll(/(\w+)=(\d+)/g)].map((x) => [x[1], Number(x[2])])); r.nginx = { total: m.total ?? 0, c2: m['2xx'] ?? 0, c3: m['3xx'] ?? 0, c4: m['4xx'] ?? 0, c5: m['5xx'] ?? 0 }; }
    else if (tag === 'TLS') { const [proto, count] = rest.split(' '); if (proto) r.tls[proto] = num(count) ?? 0; }
    else if (tag === 'TTFB') { const [sec, code] = rest.split(' '); r.ttfb.push({ ms: Math.round((num(sec) ?? 0) * 1000), code: Number(code) }); }
    else if (tag === 'SKIP') r.skipped.push(rest);
    else if (tag === 'PROM') {
      const split = rest.indexOf(' ');
      const rows = promRows(rest.slice(split + 1));
      if (!rows) { r.promFailed = true; continue; }
      for (const row of rows) (rest.slice(0, split) === 'probe_success' ? success : duration).set(row.key, row.value);
    }
  }
  if (success.size || duration.size) r.probes = [...success].map(([key, up]) => ({ key, up: up === 1, ms: duration.has(key) ? Math.round(duration.get(key) * 1000) : undefined }));
  return r;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : undefined; };

/** Facts and the problems list. A problem names what is wrong and where, never a log line. */
export function judge(r, limits = {}) {
  const t = { ...DEFAULTS, ...limits };
  const problems = [];
  const running = new Set(r.containers.filter((c) => c.state === 'up').map((c) => c.name));
  for (const c of r.containers) {
    if (c.state === 'restarting') problems.push(`container ${c.name} restarting`);
    else if (c.health === 'unhealthy') problems.push(`container ${c.name} unhealthy`);
    else if (c.state === 'exited' && c.exitCode !== 0 && c.recent) problems.push(`container ${c.name} exited (${c.exitCode ?? '?'})`);
    else if (c.state === 'dead') problems.push(`container ${c.name} dead`);
  }
  for (const d of r.disks) if (d.pct > t.disk) problems.push(`disk ${d.mount} at ${d.pct}%`);
  if (r.memTotalKb && r.memAvailKb !== undefined && (r.memAvailKb / r.memTotalKb) * 100 < t.memAvailPct) problems.push(`memory available ${Math.round((r.memAvailKb / r.memTotalKb) * 100)}%`);
  if (r.nginx) {
    if (r.nginx.c5 >= t.err5xxMin && r.nginx.c5 / Math.max(r.nginx.total, 1) >= t.err5xxShare) problems.push(`nginx 5xx: ${r.nginx.c5} of ${r.nginx.total} requests`);
  } else if (running.has('dentai-nginx')) problems.push('nginx logs not readable');
  if (r.ttfb.length) {
    const ok = r.ttfb.filter((s) => s.code === 200);
    const m = median(ok.map((s) => s.ms));
    if (!ok.length) problems.push(`origin /health answered HTTP ${r.ttfb[r.ttfb.length - 1].code}`);
    else if (m > t.ttfbSlowMs) problems.push(`origin /health TTFB ${m} ms`);
  } else if (running.has('dentai-nginx')) problems.push('origin TTFB not measured');
  if (r.probes) {
    for (const p of r.probes) {
      if (!p.up) problems.push(`probe down: ${p.key}`);
      else if (p.ms !== undefined && p.ms > t.probeSlowMs) problems.push(`probe slow: ${p.key} ${p.ms} ms`);
    }
  } else if (running.has('dentai-prometheus') || r.promFailed) problems.push('prometheus probes not readable');
  return problems;
}

/** Why ssh produced nothing usable, without echoing its stderr. */
export function classifySshFailure(stderr, code) {
  const text = String(stderr);
  if (/HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) return { error: 'host_key_changed', hint: 'the host key differs from ~/.ssh/known_hosts; verify the host before touching known_hosts' };
  if (/Permission denied/i.test(text)) return { error: 'auth_failed', hint: 'BatchMode refused: no usable key for this alias' };
  if (/timed out|Connection refused|Could not resolve|No route to host|Network is unreachable/i.test(text)) return { error: 'unreachable', hint: 'ssh could not connect' };
  return { error: 'ssh_failed', hint: `ssh exited ${code}` };
}

/** Runs ssh with the script on stdin. */
export function runSsh(alias, script, timeoutMs = DEFAULTS.sshTimeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn('ssh', sshArgs(alias), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { resolve({ code: 255, stdout: '', stderr: String(e.message) }); return; }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); stderr += ' timed out'; }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 255, stdout, stderr: stderr + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 255, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

/** One host: never throws; `status` is healthy, problems or unreachable. */
export async function checkHost(alias, opts = {}, run = runSsh, now = Date.now) {
  const started = now();
  const done = (fields) => ({ host: alias, elapsedMs: now() - started, ...fields });
  let script;
  try { script = buildRemoteScript(opts.sinceMin ?? DEFAULTS.sinceMin); sshArgs(alias); } catch (e) { return done({ status: 'unreachable', error: 'bad_input', hint: String(e.message) }); }
  const res = await run(alias, script, opts.sshTimeoutMs ?? DEFAULTS.sshTimeoutMs);
  const parsed = parseRemote(res.stdout);
  if (res.code !== 0 || !parsed.complete || parsed.uptimeSec === undefined) {
    const why = res.code !== 0 ? classifySshFailure(res.stderr, res.code) : { error: 'incomplete_answer', hint: 'the remote script did not finish' };
    return done({ status: 'unreachable', ...why });
  }
  const problems = judge(parsed, opts.limits);
  return done({ status: problems.length ? 'problems' : 'healthy', sinceMin: opts.sinceMin ?? DEFAULTS.sinceMin, facts: parsed, problems });
}

export function exitCode(results) {
  if (results.some((r) => r.status === 'problems')) return 1;
  return results.some((r) => r.status === 'unreachable') ? 3 : 0;
}

const gib = (kb) => (kb / 1048576).toFixed(1);

/** Flat `key: value` block for one host. */
export function renderHost(res) {
  const lines = [`host: ${res.host}`, `status: ${res.status}`, `elapsed_ms: ${res.elapsedMs}`];
  if (res.status === 'unreachable') {
    lines.push(`error: ${res.error}`, `hint: ${res.hint}`);
    return lines;
  }
  const f = res.facts;
  lines.push(`uptime: ${f.uptimeSec === undefined ? '?' : `${Math.floor(f.uptimeSec / 86400)}d`}, load ${f.load.map((x) => x ?? '?').join(' ')}`);
  if (f.memTotalKb) lines.push(`mem: ${Math.round((f.memAvailKb / f.memTotalKb) * 100)}% available (${gib(f.memAvailKb)} of ${gib(f.memTotalKb)} GiB)`);
  if (f.disks.length) lines.push(`disk: ${f.disks.map((d) => `${d.mount} ${d.pct}%`).join(', ')}`);
  if (f.containers.length) {
    const count = (fn) => f.containers.filter(fn).length;
    lines.push(`containers: ${f.containers.length} (healthy ${count((c) => c.health === 'healthy')}, no healthcheck ${count((c) => c.state === 'up' && c.health === 'none')}, starting ${count((c) => c.health === 'starting')}, unhealthy ${count((c) => c.health === 'unhealthy')}, restarting ${count((c) => c.state === 'restarting')}, not running ${count((c) => !['up', 'restarting'].includes(c.state))})`);
    const byImage = new Map();
    for (const c of f.containers) byImage.set(c.short, [...(byImage.get(c.short) ?? []), c.name.replace(/^dentai-/, '')]);
    lines.push(`images: ${[...byImage].map(([image, names]) => `${image} (${names.join(' ')})`).join('; ')}`);
  } else if (f.skipped.includes('docker')) lines.push('containers: docker not installed');
  if (f.stats.length) lines.push(`stats_top: ${f.stats.map((s) => `${s.name.replace(/^dentai-/, '')} ${s.cpu ?? '?'}% ${s.mem.split('/')[0]}`).join('; ')}`);
  if (f.nginx) lines.push(`nginx_${res.sinceMin}min: ${f.nginx.total} requests, 2xx ${f.nginx.c2}, 3xx ${f.nginx.c3}, 4xx ${f.nginx.c4}, 5xx ${f.nginx.c5}`);
  if (Object.keys(f.tls).length) lines.push(`tls: ${Object.entries(f.tls).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(', ')}`);
  if (f.ttfb.length) {
    const ok = f.ttfb.filter((s) => s.code === 200).map((s) => s.ms);
    lines.push(`origin_ttfb_ms: ${ok.length ? median(ok) : 'none'} (samples ${f.ttfb.map((s) => (s.code === 200 ? s.ms : `HTTP${s.code}`)).join(' ')})`);
  }
  if (f.probes) {
    const slowest = f.probes.filter((p) => p.ms !== undefined).sort((a, b) => b.ms - a.ms)[0];
    lines.push(`probes: ${f.probes.filter((p) => p.up).length} up of ${f.probes.length}${slowest ? `, slowest ${slowest.ms} ms (${slowest.key})` : ''}`);
  }
  if (f.skipped.length) lines.push(`skipped: ${f.skipped.join(', ')}`);
  lines.push(res.problems.length ? `problems: ${res.problems.length}` : 'problems: none');
  res.problems.forEach((p, i) => lines.push(`problem_${i + 1}: ${p}`));
  return lines;
}

export function render(results) {
  return `${results.map((r) => renderHost(r).join('\n')).join('\n')}\nrc: ${exitCode(results)}\n`;
}

export function parseArgs(argv) {
  const opts = { hosts: [DEFAULT_HOST], sinceMin: DEFAULTS.sinceMin, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--host') { const v = argv[++i]; if (!v) return { error: '--host needs a value' }; opts.hosts = v === 'all' ? KNOWN_HOSTS : v.split(',').filter(Boolean); }
    else if (a === '--since') { const v = Number(argv[++i]); if (!Number.isInteger(v) || v < 1 || v > 1440) return { error: '--since needs whole minutes between 1 and 1440' }; opts.sinceMin = v; }
    else return { error: `unknown argument: ${a}` };
  }
  return opts;
}

export async function main(argv, run = runSsh) {
  const opts = parseArgs(argv);
  if (opts.error) { process.stdout.write(`status: refused\nerror: ${opts.error}\nusage: prod-check.mjs [--host ALIAS[,ALIAS]|all] [--since MIN] [--json]\nrc: 2\n`); return 2; }
  const results = await Promise.all(opts.hosts.map((h) => checkHost(h, { sinceMin: opts.sinceMin }, run)));
  const code = exitCode(results);
  process.stdout.write(opts.json ? `${JSON.stringify({ rc: code, hosts: results })}\n` : render(results));
  return code;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
