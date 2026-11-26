#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const GITHUB = ['140.82.112.3', '140.82.113.3', '185.199.108.153'];
const CONTROL = ['google.com'];

export function parseProbe(out) {
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^TCP (github|control) (\S+) (True|False)$/.exec(line.trim());
    if (m) rows.push({ group: m[1], host: m[2], ok: m[3] === 'True' });
  }
  return rows;
}

export function judge(rows) {
  const gh = rows.filter((r) => r.group === 'github');
  const ctl = rows.filter((r) => r.group === 'control');
  if (!gh.length || !ctl.length) return { code: 'no-data', exit: 2, line: 'the probe returned no TCP lines' };
  const ghOk = gh.filter((r) => r.ok).length;
  if (ghOk === gh.length) return { code: 'ok', exit: 0, line: `GitHub ${ghOk}/${gh.length} reachable` };
  if (ghOk > 0) return { code: 'github-partial', exit: 1, line: `GitHub ${ghOk}/${gh.length} reachable` };
  if (!ctl.some((r) => r.ok)) return { code: 'pc-offline', exit: 1, line: 'the PC reaches neither GitHub nor the control: its whole link is down' };
  return { code: 'github-unreachable', exit: 1, line: `GitHub 0/${gh.length} reachable while the control answers: route or ISP, not the runner` };
}

function remoteScript() {
  const probe = (group, hosts) => hosts.map((h) => `"TCP ${group} ${h} $((Test-NetConnection ${h} -Port 443 -WarningAction SilentlyContinue).TcpTestSucceeded)"`).join('; ');
  return `${probe('github', GITHUB)}; ${probe('control', CONTROL)}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = spawnSync('ssh', ['-o', 'ConnectTimeout=10', process.argv[2] ?? 'pc', `pwsh -NoProfile -EncodedCommand ${Buffer.from(remoteScript(), 'utf16le').toString('base64')}`], { encoding: 'utf8', timeout: 120_000 });
  const v = r.error || r.status ? { code: 'ssh-failed', exit: 2, line: `ssh to the PC failed: ${r.error?.message ?? (r.stderr || '').trim().slice(0, 200)}` } : judge(parseProbe(r.stdout));
  console.log(`${v.code}: ${v.line}`);
  process.exit(v.exit);
}
