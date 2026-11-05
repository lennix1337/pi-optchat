import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// 04/11: `TZ=America/Sao_Paulo date` ran in dozens of calls and every report said "05/11 00:5x BRT" while it was
// 04/11 22:00 in Brasília. Git Bash ships no /usr/share/zoneinfo, so `date` treats an unknown zone name as UTC and
// prints it without any error. Offset zones need no database; Node, PowerShell and gh carry their own.

/** `TZ=<Area>/<City> date` at the start of a command; quoted text (echo, grep patterns) is not a command. */
const IANA_DATE = /(?:^|[;&|(\n])\s*TZ=(['"]?)([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)\1\s+date(?=\s|;|$)/;

/** The zone name `date` would silently ignore, or undefined. Pure so the pattern is testable. */
export function bashIanaDate(command: string): string | undefined {
  return IANA_DATE.exec(command)?.[2];
}

export function registerBashTimezoneGuard(pi: ExtensionAPI, platform: NodeJS.Platform = process.platform) {
  if (platform !== 'win32') return;
  pi.on('tool_call', event => {
    if (event.toolName !== 'bash') return;
    const command = (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string') return;
    const zone = bashIanaDate(command);
    if (!zone) return;
    return { block: true, reason: `Not run: Git Bash has no zoneinfo, so \`TZ=${zone} date\` prints UTC under that label. Use an offset zone (Brasília: \`TZ='<-03>3' date ...\`), \`date -u\` and convert, or \`powershell -NoProfile -Command '(Get-Date).ToString(\"dd/MM HH:mm\")'\`.` };
  });
}
