import { homedir } from 'node:os';






const WINDOWS_PROJECT_ARG = /(?:^|[;&|(]\s*)(?:cd|ls|cat|wc|node|python[\d.]*|bash|sh|git\s+-C)\s+(?:[^;&|\n]*\s)?["']?C:[\\/]projetos[\\/][^\s"';&|]*/iu;

export function winPathRefusal(command: string, platform: string = process.platform): string | undefined {
  if (platform !== 'linux' || !WINDOWS_PROJECT_ARG.test(command)) return undefined;
  const fixed = command.replace(/C:[\\/]projetos[\\/]/giu, `${homedir()}/projetos/`).replace(/\\/g, '/');
  return `Não executado: C:/projetos/... não existe no Linux (a VM); o repositório está em ~/projetos/<repo>. Rode de novo com: ${fixed.length > 400 ? `${fixed.slice(0, 400)}…` : fixed}`;
}
