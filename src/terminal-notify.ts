const MAX_BODY = 160;

const clean = (text: string, max: number) => {
  const line = text.replace(/[\x00-\x1f\x7f-\x9f;]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
};

/** The escape sequence that notifies in this terminal, or undefined when it has no known notification support. */
export function desktopNotification(env: Record<string, string | undefined>, title: string, body: string): string | undefined {
  const t = clean(title, 60), b = clean(body, MAX_BODY);
  if (env.TERM_PROGRAM === 'iTerm.app') return `\x1b]9;${t}: ${b}\x07`;
  if (env.TERM_PROGRAM === 'ghostty' || env.TERM_PROGRAM === 'WezTerm' || env.KITTY_WINDOW_ID || env.VTE_VERSION) return `\x1b]777;notify;${t};${b}\x07`;
  return undefined;
}

export function notifyDesktop(title: string, body: string): void {
  if (!process.stdout.isTTY) return;
  const sequence = desktopNotification(process.env, title, body);
  if (sequence) process.stdout.write(sequence);
}
