import { classifyEffects } from './autonomy.ts';

export interface Probe { argv: string[]; cwd?: string; expect: string; every?: number }

function readOptions(args: string[], methods: string[], flags: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-X' || arg === '--method' || arg === '--request') {
      if (!methods.includes(args[++i] ?? '')) return false;
    } else if (arg.startsWith('--method=') || arg.startsWith('--request=')) {
      if (!methods.includes(arg.slice(arg.indexOf('=') + 1))) return false;
    } else if (arg.startsWith('-') && !flags.includes(arg)) return false;
  }
  return true;
}

const GIT_COMMANDS = ['status', 'log', 'rev-parse', 'show', 'diff', 'describe'];
const GIT_FLAGS = ['--', '--short', '--oneline', '--stat', '--name-only', '--no-ext-diff', '--no-pager', '--abbrev-ref', '--show-toplevel', '--verify', '--quiet'];
const GH_COMMANDS: Record<string, string[]> = { run: ['list', 'view'], pr: ['view', 'checks', 'list'], issue: ['view', 'list'], release: ['view', 'list'] };
const GH_FLAGS = ['--json', '--jq', '--limit', '--repo'];
const CURL_FLAGS = ['--silent', '--show-error', '--fail', '--head', '-I', '-s', '-S', '-f'];
const ACCEPTED = `git [-C dir] ${GIT_COMMANDS.join('|')} ${GIT_FLAGS.join(' ')} (log: -N, --max-count=N), git branch --list; `
  + `gh ${Object.entries(GH_COMMANDS).map(([g, c]) => `${g} ${c.join('|')}`).join(', ')} ${GH_FLAGS.join(' ')}, gh api PATH (GET); curl URL ${CURL_FLAGS.join(' ')} (GET/HEAD)`;
/** A commit count only limits what git log prints; without it the kept output tail holds the oldest commits. */
const isCount = (command: string | undefined, a: string) => command === 'log' && /^(-\d+|--max-count=\d+)$/.test(a);

/** Fail closed: only narrow read-only forms, with no user-controlled executable paths or output destinations. */
export function validateProbe(probe: Probe, cwd: string): void {
  if (!probe || !Array.isArray(probe.argv) || !probe.argv.length || probe.argv.some(a => typeof a !== 'string' || !a || a.includes('\0')) || typeof probe.expect !== 'string') throw new Error('probe: invalid argv or expect');
  if (probe.cwd !== undefined && typeof probe.cwd !== 'string' || probe.every !== undefined && (!Number.isFinite(probe.every) || probe.every <= 0)) throw new Error('probe: invalid cwd or interval');
  try { new RegExp(probe.expect, 'i'); } catch { throw new Error('probe: invalid regular expression'); }
  const [exe, ...original] = probe.argv;
  const args = [...original];
  let safe = false;
  if (exe === 'git') {
    if (args[0] === '-C' && args.length >= 3) args.splice(0, 2);
    const command = args.shift();
    // Avoid output options, external diff drivers, remote helpers and arbitrary configuration.
    safe = GIT_COMMANDS.includes(command ?? '') && args.every(a => !a.startsWith('-') || GIT_FLAGS.includes(a) || isCount(command, a));
    if (command === 'branch') safe = args[0] === '--list' && args.slice(1).every(a => !a.startsWith('-'));
  } else if (exe === 'gh') {
    const group = args.shift(), command = args.shift();
    safe = GH_COMMANDS[group ?? '']?.includes(command ?? '') === true && args.every(a => !a.startsWith('-') || GH_FLAGS.includes(a));
    if (group === 'api') safe = !!command && !command.startsWith('-') && readOptions(args, ['GET'], []);
  } else if (exe === 'curl') {
    // Only URL operands and harmless output selection; curl's default config is disabled by the runner.
    safe = args.length > 0 && readOptions(args, ['GET', 'HEAD'], CURL_FLAGS);
  }
  // The reason goes last: a heartbeat signal keeps only the tail of a probe failure.
  if (!safe) throw new Error(`probe: accepted: ${ACCEPTED}. \`${probe.argv.join(' ')}\` is not in the read-only allowlist`);
  if (classifyEffects({ tool: 'bash', input: { command: probe.argv.join(' ') }, cwd: probe.cwd ?? cwd }).length) throw new Error('probe: command has classified effects');
}
