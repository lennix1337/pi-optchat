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
export class PanelLifecycle {
  constructor(profileId, storage) {
    this.profileId = profileId;
    this.storage = storage;
    this.key = `assistant-panel-pending:${profileId}`;
    this.refreshMarker();
    this.cursor = null;
    this.pagingStarted = false;
    this.drafts = new Map();
  }
  pollPage(cursor) { if (!this.pagingStarted) this.cursor = cursor; }
  nextPage(cursor) { this.pagingStarted = true; this.cursor = cursor; }
  saveDraft(task, text) {
    const previous = this.drafts.get(task.taskId);
    this.drafts.set(task.taskId, { revision: previous?.revision ?? task.revision, inputRevision: previous?.inputRevision ?? task.inputRevision, text });
  }
  draft(task) { return this.drafts.get(task.taskId) ?? { revision: task.revision, inputRevision: task.inputRevision, text: '' }; }
  rebaseDraft(task) {
    const draft = this.drafts.get(task.taskId);
    if (draft) this.drafts.set(task.taskId, { ...draft, revision: task.revision, inputRevision: task.inputRevision });
  }
  clearDraft(taskId) { this.drafts.delete(taskId); }
  refreshMarker() {
    const saved = this.storage.getItem(this.key);
    this.marker = saved ? JSON.parse(saved) : null;
  }
  clearMarker(expected = this.marker) {
    this.refreshMarker();
    const current = this.marker;
    if (!expected || !current || current.requestId !== expected.requestId || current.action !== expected.action || current.taskId !== expected.taskId) return false;
    this.storage.removeItem(this.key); this.marker = null; return true;
  }
  reconcile(entries) {
    this.refreshMarker();
    if (!this.marker) return false;
    const found = entries.some(({ event }) => event.profileId === this.profileId && event.source?.sourceEventId === this.marker.requestId && (!this.marker.taskId || event.taskId === this.marker.taskId));
    return found && this.clearMarker();
  }
  async write(marker, send, history) {
    this.refreshMarker();
    if (this.marker) throw new Error('pending mutation');
    // Persist only identifiers, before the request can leave the browser.
    const pending = { requestId: marker.requestId, action: marker.action, ...(marker.taskId ? { taskId: marker.taskId } : {}) };
    this.storage.setItem(this.key, JSON.stringify(pending));
    this.marker = pending;
    let task;
    try { task = await send(); }
    catch (error) {
      // These statuses are emitted before mutation, or after the store rolled back a conflict.
      if ([400, 401, 403, 404, 409].includes(error.status)) this.clearMarker(pending);
      throw error;
    }
    this.clearMarker(pending);
    try { await history(); return { task }; }
    catch (historyError) { return { task, historyError }; }
  }
}
export async function coordinatedWrite(lifecycle, locks, marker, send, history) {
  if (!locks?.request) throw new Error('coordination unavailable');
  return locks.request(lifecycle.key, { ifAvailable: true }, lock => {
    if (!lock) throw new Error('panel busy');
    return lifecycle.write(marker, send, history);
  });
}
export async function coordinatedReconcile(lifecycle, locks, entries) {
  if (!locks?.request) return false;
  return locks.request(lifecycle.key, { ifAvailable: true }, lock => lock ? lifecycle.reconcile(entries) : false);
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
export function channelMark(name) {
  const trimmed = name.trim();
  let hash = 0;
  for (const char of trimmed) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return { hue: hash, initial: trimmed ? [...trimmed][0].toLocaleUpperCase('pt-BR') : '#' };
}
const MAX_TASK_ID = 200;
export function taskLink(taskId) { return `#tarefa=${encodeURIComponent(taskId)}`; }
export function deepLinkTask(hash) {
  const match = /^#tarefa=([^&=#]+)$/.exec(hash);
  if (!match) return null;
  let taskId;
  try { taskId = decodeURIComponent(match[1]); } catch { return null; }
  return taskId.length <= MAX_TASK_ID && !/\p{Cc}/u.test(taskId) ? taskId : null;
}
// Chat originals are opened by the terminal client; the panel never fetches or links an evidence reference.
export function originalAccess(reference) {
  return /^optchat:[A-Za-z0-9_.-]+:\d+$/.test(reference) ? { kind: 'chat', command: `/assistant original ${reference}` } : { kind: 'text' };
}
export class ResponseQueue {
  constructor() { this.items = []; }
  add({ taskId, text, revision, inputRevision }) {
    if (!text.trim()) throw new Error('empty response');
    const item = { id: crypto.randomUUID(), taskId, text, revision, inputRevision };
    this.items.push(item); return item;
  }
  pending() { return [...this.items]; }
  remove(id) { this.items = this.items.filter(item => item.id !== id); }
  // send resolves true only when the result was confirmed; anything else holds the rest in order.
  async drain(send) {
    while (this.items.length) {
      const item = this.items.shift();
      if (!await send(item)) return false;
    }
    return true;
  }
}
export class ChannelArchive {
  constructor(profileId, storage) {
    this.storage = storage; this.key = `assistant-panel-archived-channels:${profileId}`;
    let saved = [];
    try { saved = JSON.parse(storage.getItem(this.key) ?? '[]'); } catch { saved = []; }
    this.names = new Set(Array.isArray(saved) ? saved.filter(name => typeof name === 'string') : []);
  }
  has(name) { return this.names.has(name); }
  archive(name) { this.names.add(name); this.save(); }
  restore(name) { this.names.delete(name); this.save(); }
  save() { this.storage.setItem(this.key, JSON.stringify([...this.names])); }
}
export function attention(task) { return ['needs_input', 'ready_for_review', 'suggested'].includes(task.status); }
