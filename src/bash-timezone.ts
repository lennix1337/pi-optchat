import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';


// external: Git Bash may lack zoneinfo, so date silently treats unknown TZ names as UTC.



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
