// external: A background shell reports its own completion, so a foreground sleep only burns the turn.
export function withoutQuotedText(command: string): string {
  return command
    .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/gu, '')
    .replace(/"(?:[^"\\]|\\[\s\S])*"|'[^']*'/gu, '""');
}

export function sleepsToWait(command: string): boolean {
  if (/\b(?:while|until|for)\b[^\n]*;\s*do\b[^\n]*\bsleep\s+\d/u.test(command)) return true;
  return [...command.matchAll(/(?:^|[;&|\n(]\s*)sleep\s+(\d+(?:\.\d+)?)([smhd]?)/gu)].some(m => Number(m[1]) * ({ m: 60, h: 3600, d: 86400 }[m[2]] ?? 1) >= 15);
}

export function sleepPollRefusal(command: string): string | undefined {
  if (process.env.OPTCHAT_SLEEP_GUARD === 'off' || !sleepsToWait(withoutQuotedText(command))) return undefined;
  return 'Não executado: esperar resultado com `sleep` (15 s ou mais, ou em loop) gasta o turno. Rode o trabalho com `shell_start` (notify end) ou deixe o gitwatch avisar, e siga com outra coisa.';
}
