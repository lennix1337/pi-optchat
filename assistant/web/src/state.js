export class PanelState {
  constructor(profileId) {
    this.profileId = profileId;
    this.tasks = new Map();
    this.events = [];
    this.after = 0;
    this.revision = 0;
    this.channels = new Map();
  }
  upsert(task) {
    if (task.profileId !== this.profileId) throw new Error('profile mismatch');
    const current = this.tasks.get(task.taskId);
    if (!current || task.revision > current.revision) {
      this.tasks.set(task.taskId, task); this.revision++;
    }
  }
  apply(entries) {
    let after = this.after;
    const fresh = entries.filter(entry => entry.event.sequence > this.after);
    for (const entry of fresh) {
      if (entry.event.profileId !== this.profileId || entry.task.profileId !== this.profileId) throw new Error('profile mismatch');
      if (entry.event.sequence !== ++after) throw new Error('event sequence gap');
    }
    for (const entry of fresh) {
      this.upsert(entry.task);
      if (!this.channels.has(entry.task.taskId)) {
        this.channels.set(entry.task.taskId, entry.event.channelId); this.revision++;
      }
      this.events.push(entry);
    }
    this.after = after;
  }
}
export const labels = {
  suggested: 'Sugestão', queued: 'Na fila', working: 'Em andamento', needs_input: 'Precisa de você',
  ready_for_review: 'Revisar resultado', succeeded: 'Concluída', failed: 'Falhou', cancelled: 'Cancelada', resolved: 'Arquivada',
};
export const actions = {
  suggested: [['queued', 'Iniciar'], ['cancelled', 'Recusar']], queued: [['cancelled', 'Cancelar']],
  working: [['cancelled', 'Cancelar']], needs_input: [['cancelled', 'Cancelar']],
  ready_for_review: [['succeeded', 'Aceitar resultado'], ['failed', 'Pedir correção']],
  succeeded: [['resolved', 'Arquivar']], failed: [['queued', 'Tentar novamente'], ['resolved', 'Arquivar']],
  cancelled: [['resolved', 'Arquivar']], resolved: [],
};
export function attention(task) { return ['needs_input', 'ready_for_review', 'suggested'].includes(task.status); }
