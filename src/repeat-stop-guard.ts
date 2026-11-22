import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const normalize = (command: string) => command.trim().replace(/\s+/g, ' ');

export function registerRepeatStop(pi: ExtensionAPI) {
  const sessions = new Map<string, { command: string; error: string; count: number }>();
  pi.on('tool_result', (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const command = (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string') return;
    const session = ctx.sessionManager.getSessionId();
    if (!event.isError) { sessions.delete(session); return; }
    const output = event.content.map(part => part.type === 'text' ? part.text : '').join('\n').trim();
    const error = output.slice(0, 300);
    const normalized = normalize(command);
    const previous = sessions.get(session);
    sessions.set(session, { command: normalized, error, count: previous?.command === normalized && previous.error === error ? previous.count + 1 : 1 });
  });
  pi.on('session_start', (_event, ctx) => { sessions.delete(ctx.sessionManager.getSessionId()); });
  pi.on('session_shutdown', (_event, ctx) => { sessions.delete(ctx.sessionManager.getSessionId()); });
  return (session: string, command: string): string | undefined => {
    const previous = sessions.get(session);
    if (!previous) return;
    if (previous.command !== normalize(command)) { sessions.delete(session); return; }
    if (previous.count >= 2) return 'Não executado: o mesmo comando falhou duas vezes com o mesmo erro. Leia o erro e mude de abordagem, use outra rota ou peça ajuda.';
  };
}
