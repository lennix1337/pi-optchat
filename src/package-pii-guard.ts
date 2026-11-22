import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { ToolUse } from './ripwire-first-guard.ts';

type Hooks = { on(event: string, handler: (event: any, ctx: any) => unknown): unknown };
const PACKAGE_PATH = /[\\/]projetos[\\/](?!dotfiles[\\/]|dentai-mono[\\/])/u;
const PHONE = /\b55\d{10,11}\b/gu;

/** Historical scan detector: only added text in absolute project edit/write paths. */
export function writesRealPhone(call: { name?: string; arguments?: Record<string, unknown> }): boolean {
  if ((call.name !== 'edit' && call.name !== 'write') || !PACKAGE_PATH.test(String(call.arguments?.path ?? ''))) return false;
  const edits = Array.isArray(call.arguments?.edits) ? call.arguments.edits : [call.arguments];
  return edits.some((e: { newText?: string; content?: string } | undefined) =>
    (String(e?.newText ?? e?.content ?? '').match(PHONE) ?? []).some(n => !n.includes('0000')));
}

function packagePath(path: string, cwd: string): string | undefined {
  const root = join(homedir(), 'projetos');
  const target = resolve(cwd, path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
  const rel = relative(root, target);
  const parts = rel.split(sep);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || parts.length < 2 || ['dotfiles', 'dentai-mono'].includes(parts[0])) return undefined;
  return target;
}

function writesPii(call: ToolUse, cwd: string): boolean {
  if (call.name === 'edit' || call.name === 'write') {
    const path = packagePath(String(call.arguments?.path ?? ''), cwd);
    return !!path && writesRealPhone({ ...call, arguments: { ...call.arguments, path } });
  }
  if (call.name !== 'bash') return false;
  const command = String(call.arguments?.command ?? '');
  const heredoc = /(?:^|\n)([^\n]*<<-?\s*(['"]?)([\w]+)\2[^\n]*)\n([\s\S]*?)\n\s*\3(?=\s|$)/gu;
  for (const match of command.matchAll(heredoc)) {
    const destination = match[1].match(/(?:^|\s)>{1,2}\s*(['"]?)([^\s'";&|]+)\1/u)?.[2];
    const cd = match[1].match(/(?:^|[;&])\s*cd\s+(['"]?)([^\s'";&|]+)\1\s*&&/u)?.[2];
    const path = destination && packagePath(destination, cd ? resolve(cwd, cd) : cwd);
    if (path && writesRealPhone({ name: 'write', arguments: { path, content: match[4] } })) return true;
  }
  return false;
}

export function packagePiiGuard() {
  const refused = new Set<string>();
  return {
    check(call: ToolUse, cwd: string): string | undefined {
      if (!writesPii(call, cwd)) return undefined;
      const key = JSON.stringify([call.name, call.arguments, cwd]);
      if (refused.has(key)) return undefined;
      refused.add(key);
      return 'Não executado: pacote não deve conter telefone pessoal. Use um número falso (5500000000000) ou configuração local.';
    },
  };
}

export function registerPackagePiiGuard(pi: Hooks) {
  if (process.env.OPTCHAT_PACKAGE_PII === 'off') return;
  const guard = packagePiiGuard();
  pi.on('tool_call', (event: { toolName: string; input: Record<string, unknown> }, ctx: { cwd: string }) => {
    const reason = guard.check({ name: event.toolName, arguments: event.input }, ctx.cwd);
    return reason ? { block: true, reason } : undefined;
  });
}
