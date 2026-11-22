import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const normalize = (command: string) => command.trim().replace(/\s+/g, ' ');

export function registerRepeatStop(pi: ExtensionAPI) {
  const sessions = new Map<string, Map<string, { error: string; count: number }>>();
  pi.on('tool_result', (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const command = (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string') return;
    const session = ctx.sessionManager.getSessionId();
    const normalized = normalize(command);
    let commands = sessions.get(session);
    if (!event.isError) {
      commands?.delete(normalized);
      if (commands?.size === 0) sessions.delete(session);
      return;
    }
    if (!commands) sessions.set(session, commands = new Map());
    const output = event.content.map(part => part.type === 'text' ? part.text : '').join('\n').trim();
    const error = output.slice(0, 300);
    const previous = commands.get(normalized);
    commands.delete(normalized);
    commands.set(normalized, { error, count: previous?.error === error ? previous.count + 1 : 1 });
    if (commands.size > 20) commands.delete(commands.keys().next().value!);
  });
  pi.on('session_start', (_event, ctx) => { sessions.delete(ctx.sessionManager.getSessionId()); });
  pi.on('session_shutdown', (_event, ctx) => { sessions.delete(ctx.sessionManager.getSessionId()); });
  return (session: string, command: string): string | undefined => {
    const commands = sessions.get(session);
    const normalized = normalize(command);
    const previous = commands?.get(normalized);
    if (!previous) return;
    commands!.delete(normalized);
    commands!.set(normalized, previous);
    if (previous.count >= 2) return 'Não executado: o mesmo comando falhou duas vezes com o mesmo erro. Leia o erro e mude de abordagem, use outra rota ou peça ajuda.';
  };
}
