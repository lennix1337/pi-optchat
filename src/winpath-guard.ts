import { homedir } from 'node:os';

/**
 * On the Linux VM `C:/projetos/<repo>` does not exist; the same repo lives in `~/projetos/<repo>`. Four times in one
 * session (20/11) a command such as `node C:/projetos/pi-optchat/scripts/ship.mjs` failed with MODULE_NOT_FOUND and
 * the after-the-fact hint cost a second call. The call is refused before it runs, with the exact rewrite.
 */
const WINDOWS_PROJECT_ARG = /(?:^|[;&|(]\s*)(?:cd|ls|cat|wc|node|python[\d.]*|bash|sh|git\s+-C)\s+(?:[^;&|\n]*\s)?["']?C:[\\/]projetos[\\/][^\s"';&|]*/iu;

export function winPathRefusal(command: string, platform: string = process.platform): string | undefined {
  if (platform !== 'linux' || !WINDOWS_PROJECT_ARG.test(command)) return undefined;
  const fixed = command.replace(/C:[\\/]projetos[\\/]/giu, `${homedir()}/projetos/`).replace(/\\/g, '/');
  return `Não executado: C:/projetos/... não existe no Linux (a VM); o repositório está em ~/projetos/<repo>. Rode de novo com: ${fixed.length > 400 ? `${fixed.slice(0, 400)}…` : fixed}`;
}
