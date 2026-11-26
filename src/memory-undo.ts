import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readExecLog } from './exec-log.ts';
import type { Memory } from './memory.ts';

export type UndoCommand = { action: 'undo' | 'redo'; arg: string; slack?: string; seq?: number };
export const slackMemoryKey = (channel: string, ts: string) => `slack:${channel}:${ts}`;

export function registerMemoryUndo(pi: Pick<ExtensionAPI, 'registerCommand'>, current: () => Memory | undefined) {
  const use = ({ action, arg, slack, seq }: UndoCommand) => {
    const memory = current();
    if (!memory) return 'Aguarde o OptChat ficar livre com um perfil aberto e tente de novo.';
    try {
      if (memory.handledSlackCommand(seq)) return 'Esse comando já foi aplicado à memória.';
      if (action === 'redo') {
        if (arg.trim()) return 'Use /redo sem argumentos.';
        return memory.redo(seq) ? 'Último lote restaurado na memória.' : 'Não há lote oculto para restaurar.';
      }
      if (arg.trim() && !/^\d+$/.test(arg.trim())) return 'Use /undo [N], com um número inteiro positivo.';
      const range = memory.undo(arg.trim() ? Number(arg) : 1, slack, seq);
      if (!range) return slack ? 'Essa mensagem não está visível no histórico do OptChat.' : 'Não há mensagens visíveis suficientes para desfazer.';
      const calls = new Set(memory.root.slice(range.from, range.to).filter(e => e.kind === 'tool' || e.kind === 'echo').map(e => e.receipt).filter(Boolean));
      const effects = calls.size ? readExecLog(memory.directory).filter(row => row.call && calls.has(row.call)).flatMap(row => row.effects ?? []) : [];
      return ['Mensagens ocultadas da memória. Use /redo para restaurar.', ...(effects.length ? ['Isso já foi executado e não volta:',
        ...new Set(effects.map(e => `• ${e.label} — ${e.revert}`))] : [])].join('\n');
    } catch (error) { return error instanceof Error ? error.message : String(error); }
  };
  for (const action of ['undo', 'redo'] as const) pi.registerCommand(action, {
    description: action === 'undo' ? 'Hide the last exchange or N raw memory entries (without reversing effects)' : 'Restore the last hidden batch to memory',
    handler: async (arg, ctx) => { ctx.ui.notify(use({ action, arg }), 'info'); },
  });
  return use;
}
