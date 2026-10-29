import { PanelState, PanelLifecycle, ResponseQueue, ChannelArchive, DeclinedSources, setupLabels, coordinatedWrite, coordinatedReconcile, channelMark, deepLinkTask, taskLink, originalAccess, actions, attention, labels } from './state.js';
import { startArtifacts, stopArtifacts } from './artifacts/artifacts.js';
import { startVoice, stopVoice } from './voice/voice-ui.js';

const $ = selector => document.querySelector(selector);
let state;
let csrf;
let filter = 'attention';
let selectedTask;
let lifecycle;
let timer;
let syncing = false;
let mutationPending = false;
let draining = false;
let archive;
let declined;
const queue = new ResponseQueue();
const uncertain = () => Boolean(lifecycle?.marker);
let renderedKey;
const channelId = `panel-${crypto.randomUUID()}`;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function notice(message) { $('#notice').textContent = message; }
class RequestError extends Error {
  constructor(status, body) { super(`request_${status}`); this.status = status; this.body = body; }
}
async function request(path, body) {
  const options = { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) };
  if (body !== undefined) {
    options.method = 'POST';
    options.headers = { 'content-type': 'application/json', 'x-assistant-csrf': csrf ?? '' };
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  const value = await res.json();
  if (!res.ok) throw new RequestError(res.status, value);
  return value;
}
function signedOut() {
  clearTimeout(timer); state = undefined; csrf = undefined;
  stopArtifacts(); stopVoice();
  $('#workspace').hidden = true; $('#logout').hidden = true; $('#login').hidden = false;
  $('#task-list').replaceChildren(); $('#evidence-list').replaceChildren();
  $('#setup').hidden = true; $('#task-list').hidden = false;
}
async function start(session) {
  csrf = session.csrf; state = new PanelState(session.profileId);
  lifecycle = new PanelLifecycle(session.profileId, localStorage);
  archive = new ChannelArchive(session.profileId, localStorage);
  declined = new DeclinedSources(session.profileId, localStorage);
  $('#login').hidden = true; $('#workspace').hidden = false; $('#logout').hidden = false;
  $('#profile').textContent = `Perfil ${session.profileId} · serviço local`;
  selectedTask = undefined; renderedKey = undefined;
  $('#create-form button').disabled = uncertain();
  startArtifacts(request);
  // Voice text enters only through the same create path; a busy or uncertain panel refuses it.
  void startVoice(request, async ({ text }) => {
    if (uncertain() || mutationPending) throw new Error('panel busy');
    await mutate('/web/api/tasks', { title: text, channelId: 'Voz' });
  });
  if (uncertain()) notice('Resultado não confirmado. Atualize o histórico antes de repetir a ação.');
  await sync(true);
  openDeepLink();
}
async function sync(manual = false) {
  if (!state || syncing) return;
  syncing = true; clearTimeout(timer);
  try {
    const page = await request('/web/api/tasks?limit=100');
    for (const task of page.tasks) state.upsert(task);
    lifecycle.pollPage(page.nextCursor);
    const reconciled = await events();
    if (manual && !uncertain() && !reconciled) notice('');
    $('#create-form button').disabled = uncertain() || mutationPending;
    $('#connection').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')} · evento ${state.after}`;
    render();
    void drainQueue();
  } catch (error) {
    if (error.status === 401) { signedOut(); notice('Sessão encerrada. Entre novamente.'); }
    else { $('#connection').textContent = 'Sem conexão · estado pode estar desatualizado'; notice('Não foi possível atualizar. Nenhuma ação será reenviada automaticamente.'); }
  } finally {
    syncing = false;
    $('#more').disabled = false;
    if (state) timer = setTimeout(() => sync(), 5000);
  }
}
async function events() {
  const entries = await request(`/web/api/events?after=${state.after}&limit=100`);
  state.apply(entries);
  const reconciled = await coordinatedReconcile(lifecycle, navigator.locks, state.events);
  if (reconciled) {
    notice('A ação anterior foi encontrada no histórico. Confira o resultado antes de continuar.');
    $('#create-form button').disabled = mutationPending;
  }
  $('#more-events').hidden = entries.length < 100;
  renderEvidence();
  return reconciled;
}
function channelOptions() {
  const select = $('#channel'); const selected = select.value;
  const channels = [...new Set(state.channels.values())].sort();
  const archived = channels.filter(name => archive.has(name));
  const options = [new Option('Todos os assuntos', ''), ...channels.filter(name => !archive.has(name)).map(name => new Option(name, name))];
  if (archived.length) {
    const group = document.createElement('optgroup'); group.label = 'Assuntos arquivados';
    group.append(...archived.map(name => new Option(name, name))); options.push(group);
  }
  select.replaceChildren(...options);
  if (channels.includes(selected)) select.value = selected;
  const toggle = $('#archive-channel');
  toggle.hidden = !select.value;
  toggle.textContent = archive.has(select.value) ? 'Restaurar assunto' : 'Arquivar assunto';
}
function render() {
  if (!state) return;
  const key = `${state.revision}:${filter}:${$('#channel').value}:${$('#project').value}:${uncertain()}:${mutationPending}:${lifecycle.cursor}:${queue.pending().map(item => item.id).join()}:${[...archive.names].join()}`;
  if (key === renderedKey) return;
  renderedKey = key;
  channelOptions();
  const tasks = [...state.tasks.values()];
  // Each task's latest event: when it last moved and, for work OptChat mirrors, what it reported.
  const latest = new Map();
  for (const entry of state.events) latest.set(entry.event.taskId, entry.event);
  const updated = task => latest.get(task.taskId)?.sequence ?? 0;
  $('#attention-count').textContent = String(tasks.filter(attention).length);
  const selected = $('#channel').value, project = $('#project').value;
  const visible = tasks.filter(task => {
    if (project && state.projects.get(task.taskId) !== project) return false;
    if (selected && state.channels.get(task.taskId) !== selected) return false;
    if (!selected && archive.has(state.channels.get(task.taskId))) return false;
    if (filter === 'attention') return attention(task);
    if (filter === 'active') return ['queued', 'working'].includes(task.status);
    if (filter === 'archive') return task.status === 'resolved';
    return task.status !== 'resolved';
  }).sort((a, b) => Number(attention(b)) - Number(attention(a)) || updated(b) - updated(a) || a.title.localeCompare(b.title, 'pt-BR'));
  const list = $('#task-list');
  const focused = document.activeElement;
  const focusedTask = focused?.matches('.response-form textarea') ? focused.closest('.task')?.dataset.taskId : undefined;
  const selection = focusedTask ? [focused.selectionStart, focused.selectionEnd] : null;
  list.replaceChildren(...visible.map(task => card(task, latest.get(task.taskId))));
  if (focusedTask) {
    const replacement = [...list.children].find(node => node.dataset.taskId === focusedTask)?.querySelector('.response-form textarea');
    if (replacement) { replacement.focus(); replacement.setSelectionRange(...selection); }
  }
  if (!visible.length) {
    const empty = el('div', undefined, 'empty');
    empty.append(el('h2', filter === 'attention' ? 'Nenhuma decisão esperando.' : 'Nenhuma tarefa nesta vista.'), el('p', 'O estado mostrado vem deste perfil. Você pode mudar a vista ou colocar uma tarefa na fila.'));
    list.append(empty);
  }
  $('#more').hidden = !lifecycle.cursor;
  $('#more').disabled = syncing;
}
const PROJECT_NAMES = { dentai: 'DentAI', genexus18mcp: 'GeneXus18MCP', harness: 'Harness' };
function card(task, last) {
  const article = el('article', undefined, 'task'); article.dataset.taskId = task.taskId;
  const meta = el('div', undefined, 'task-meta');
  const channel = state.channels.get(task.taskId);
  const subject = el('span', undefined, 'task-channel');
  if (channel) {
    const mark = channelMark(channel);
    const badge = el('span', mark.initial, 'channel-mark'); badge.setAttribute('aria-hidden', 'true'); badge.style.setProperty('--hue', String(mark.hue));
    subject.append(badge, channel);
  } else subject.textContent = 'Canal não carregado';
  meta.append(el('span', labels[task.status], 'task-status'), subject);
  const project = state.projects.get(task.taskId);
  if (project) meta.append(el('span', PROJECT_NAMES[project] ?? project, `task-project project-${project}`));
  meta.append(el('span', `rev. ${task.revision}`));
  if (last) meta.append(el('span', `atualizado ${new Date(last.observedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}`));
  const heading = el('h3'); const link = el('a', task.title); link.href = taskLink(task.taskId); heading.append(link);
  article.tabIndex = -1;
  article.append(meta, heading);
  // Notes OptChat reports on its own work (src/work-tracker.ts): what it says, not verification.
  if (last?.source.actorId === 'assistant-client' && last.evidence.reference !== '-') article.append(el('p', last.evidence.reference, 'task-note'));
  const verification = { verified: 'Verificado', not_verified: 'Resultado não verificado', blocked: 'Verificação bloqueada' };
  article.append(el('p', verification[task.verification], 'task-verification'));
  const details = el('details'); details.append(el('summary', 'Identidade da tarefa'), el('p', `${task.taskId} · origem ${task.sourceEventId}`)); article.append(details);
  if (task.status === 'needs_input') article.append(responseForm(task));
  if (task.status === 'ready_for_review') article.append(el('p', 'Aceitar muda o estado da tarefa; não autoriza um envio nem verifica um efeito externo.', 'hint'));
  const controls = el('div', undefined, 'task-actions');
  for (const [nextStatus, label] of actions[task.status] ?? []) {
    const button = el('button', label); button.disabled = uncertain() || mutationPending;
    button.addEventListener('click', () => mutate(`/web/api/tasks/${encodeURIComponent(task.taskId)}/transition`, { expectedRevision: task.revision, nextStatus }));
    controls.append(button);
  }
  const evidence = el('button', 'Ver fontes');
  evidence.addEventListener('click', () => { selectedTask = task.taskId; renderEvidence(); $('#evidence-heading').scrollIntoView({ block: 'nearest', behavior: 'auto' }); });
  controls.append(evidence); article.append(controls); return article;
}
function responseForm(task) {
  const form = el('form', undefined, 'response-form');
  const id = `response-${crypto.randomUUID()}`;
  const draft = lifecycle.draft(task);
  const label = el('label', `Sua resposta · pedido ${draft.inputRevision}`); label.htmlFor = id;
  const input = el('textarea'); input.id = id; input.required = true; input.maxLength = 4000; input.value = draft.text;
  input.addEventListener('input', () => lifecycle.saveDraft(task, input.value));
  const stale = draft.revision !== task.revision || draft.inputRevision !== task.inputRevision;
  const button = el('button', mutationPending ? 'Enfileirar resposta' : 'Responder ao pedido atual', 'primary'); button.type = 'submit'; button.disabled = stale || uncertain();
  form.append(label, input);
  const queued = queue.pending().filter(item => item.taskId === task.taskId);
  if (queued.length) {
    const list = el('ol', undefined, 'queued');
    list.setAttribute('aria-label', 'Respostas na fila, na ordem em que você escreveu');
    for (const item of queued) {
      const entry = el('li', `Na fila: ${item.text}`);
      const remove = el('button', 'Tirar da fila'); remove.type = 'button';
      remove.addEventListener('click', () => { queue.remove(item.id); renderedKey = undefined; render(); });
      entry.append(remove); list.append(entry);
    }
    form.append(list);
  }
  if (stale) {
    form.append(el('p', `Rascunho: pedido ${draft.inputRevision}, revisão da tarefa ${draft.revision}. Pedido atual: ${task.inputRevision}, revisão da tarefa ${task.revision}. Revise o pedido atual antes de vincular este texto a ele.`, 'hint'));
    const review = el('button', 'Revisar pedido atual'); review.type = 'button';
    review.addEventListener('click', () => {
      const current = state.tasks.get(task.taskId);
      if (!current || current.revision !== task.revision || current.inputRevision !== task.inputRevision || current.status !== 'needs_input') {
        renderedKey = undefined; render(); return;
      }
      lifecycle.rebaseDraft(current);
      renderedKey = undefined; render();
    });
    form.append(review);
  }
  form.append(button);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (stale || !input.value.trim() || uncertain()) return;
    if (mutationPending || queue.pending().length) {
      queue.add({ taskId: task.taskId, text: input.value, revision: draft.revision, inputRevision: draft.inputRevision });
      lifecycle.clearDraft(task.taskId);
      notice('Resposta na fila. Ela será enviada depois que a ação atual for confirmada, na ordem em que você escreveu.');
      renderedKey = undefined; render(); return;
    }
    void mutate(`/web/api/tasks/${encodeURIComponent(task.taskId)}/respond`, { revision: draft.revision, inputRevision: draft.inputRevision, text: input.value });
  });
  return form;
}
async function drainQueue() {
  if (draining || uncertain() || mutationPending || !queue.pending().length) return;
  draining = true;
  try {
    const done = await queue.drain(item => mutate(`/web/api/tasks/${encodeURIComponent(item.taskId)}/respond`, { revision: item.revision, inputRevision: item.inputRevision, text: item.text }));
    if (!done && queue.pending().length) notice('A fila parou porque uma resposta não foi confirmada. As próximas continuam guardadas; revise antes de enviar.');
  } finally { draining = false; renderedKey = undefined; render(); }
}
async function mutate(path, input) {
  if (uncertain() || mutationPending) return false;
  let confirmed = false;
  mutationPending = true;
  document.querySelectorAll('.task-actions button, .response-form button, #create-form button').forEach(button => { button.disabled = true; });
  try {
    const requestId = crypto.randomUUID();
    const match = /^\/web\/api\/tasks\/([^/]+)\/(transition|respond)$/.exec(path);
    const marker = { requestId, action: match?.[2] ?? 'create', ...(match ? { taskId: decodeURIComponent(match[1]) } : {}) };
    const result = await coordinatedWrite(lifecycle, navigator.locks, marker, () => request(path, { requestId, channelId, ...input }), events);
    state.upsert(result.task);
    if (marker.action === 'respond') lifecycle.clearDraft(marker.taskId);
    notice(result.historyError ? 'Estado salvo, mas o histórico está indisponível. Atualize para consultá-lo.' : 'Estado salvo. Nenhum efeito externo foi autorizado.');
    if (path === '/web/api/tasks') { $('#title').value = ''; filter = 'active'; updateFilters(); }
    confirmed = true;
  } catch (error) {
    if (error.status === 409) {
      if (error.body.task) state.upsert(error.body.task);
      notice('Esta decisão já mudou. Revise o estado atual antes de responder outra vez.');
    } else if (error.status === 401) { signedOut(); notice('Sessão encerrada. Entre novamente.'); }
    else if ([400, 403, 404].includes(error.status)) notice('Pedido recusado sem alterar a tarefa. Atualize a página para renovar a sessão e revise o pedido antes de tentar novamente.');
    else if (error.message === 'panel busy') notice('Outra aba está enviando uma ação. Confira o estado depois que ela terminar; nada foi enviado nesta aba.');
    else if (error.message === 'coordination unavailable') notice('Este navegador não oferece coordenação segura entre abas. Use Edge ou Chromium neste computador; nada foi enviado.');
    else {
      notice(uncertain() ? 'Resultado não confirmado. Não repita o clique: use Atualizar para procurar a ação no histórico. As ações ficam bloqueadas até a confirmação.' : 'Não foi possível guardar o marcador de segurança. Nenhuma ação foi enviada.');
    }
  } finally {
    mutationPending = false;
    $('#create-form button').disabled = uncertain();
    renderedKey = undefined;
    render();
    if (confirmed && !draining) void drainQueue();
  }
  return confirmed;
}
function renderEvidence() {
  if (!state || !selectedTask) return;
  const task = state.tasks.get(selectedTask);
  $('#evidence-intro').textContent = task ? task.title : 'Tarefa selecionada';
  const entries = state.events.filter(entry => entry.event.taskId === selectedTask);
  const nodes = entries.map(entry => {
    const li = el('li'); const event = entry.event;
    const time = el('time', new Date(event.observedAt).toLocaleString('pt-BR')); time.dateTime = event.observedAt;
    li.append(el('p', `${labels[entry.task.status]} · evento ${event.sequence}`), time,
      el('p', `${event.source.actorId} · ${event.source.sourceKind}`), el('p', event.channelId), el('code', event.evidence.reference));
    const access = originalAccess(event.evidence.reference);
    if (access.kind === 'chat') {
      const copy = el('button', 'Copiar comando do original');
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(access.command); notice('Comando copiado. Abra o original no terminal do OptChat; o painel não lê o chat.'); }
        catch { notice(`Copie e rode no terminal: ${access.command}`); }
      });
      li.append(copy);
    }
    return li;
  });
  if (!entries.length) nodes.push(el('li', 'Ainda não há eventos carregados para esta tarefa. Atualize ou carregue mais eventos.'));
  $('#evidence-list').replaceChildren(...nodes);
}
function updateFilters() {
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === filter)));
}
$('#filters').addEventListener('click', event => {
  const button = event.target.closest('[data-filter]'); if (!button) return;
  filter = button.dataset.filter; updateFilters(); render();
});
window.addEventListener('storage', event => {
  if (!state || (event.key !== null && event.key !== lifecycle.key)) return;
  try {
    lifecycle.refreshMarker();
    $('#create-form button').disabled = uncertain() || mutationPending;
    if (uncertain()) notice('Outra aba tem uma ação sem resultado confirmado. Atualize o histórico antes de enviar outra ação.');
    renderedKey = undefined; render();
  } catch {
    signedOut(); notice('Não foi possível consultar o marcador de segurança. Entre novamente antes de continuar.');
  }
});
function openDeepLink() {
  const taskId = deepLinkTask(location.hash);
  if (!taskId || !state) return;
  const task = state.tasks.get(taskId);
  if (!task) { notice('A tarefa do link não está carregada neste perfil. Carregue mais tarefas ou confira o link.'); return; }
  const channel = state.channels.get(taskId);
  filter = 'all'; if (task.status === 'resolved') filter = 'archive';
  if ($('#channel').value && $('#channel').value !== channel) $('#channel').value = '';
  if (archive.has(channel)) $('#channel').value = channel;
  updateFilters(); renderedKey = undefined; render();
  selectedTask = taskId; renderEvidence();
  const node = [...$('#task-list').children].find(child => child.dataset.taskId === taskId);
  node?.focus(); node?.scrollIntoView({ block: 'start', behavior: 'auto' });
}
window.addEventListener('hashchange', openDeepLink);
const optional = new Set(['model', 'isolation', 'google', 'notifications']);
async function showSetup() {
  $('#setup').hidden = false; $('#task-list').hidden = true; $('#more').hidden = true;
  $('#setup-list').replaceChildren(el('li', 'Verificando localmente\u2026'));
  let body;
  try { body = await request(`/web/api/setup?declined=${encodeURIComponent([...declined.names].join(','))}`); }
  catch (error) {
    if (error.status === 401) { signedOut(); notice('Sess\u00e3o encerrada. Entre novamente.'); return; }
    $('#setup-list').replaceChildren(el('li', error.status === 404 ? 'Este servi\u00e7o n\u00e3o exp\u00f5e a configura\u00e7\u00e3o.' : 'N\u00e3o foi poss\u00edvel verificar agora. Nada foi marcado como pronto.')); return;
  }
  $('#setup-list').replaceChildren(...body.items.map(item => {
    const li = el('li', undefined, `setup-item setup-${item.status}`);
    li.append(el('strong', item.label), el('span', setupLabels[item.status], 'setup-status'), el('p', item.detail));
    if (item.status !== 'ready') li.append(el('p', `Como resolver: ${item.fix}`, 'hint'));
    if (optional.has(item.id) && item.status !== 'ready') {
      const skip = el('button', declined.has(item.id) ? 'Desfazer "Agora não"' : 'Agora não'); skip.type = 'button';
      skip.addEventListener('click', () => { if (declined.has(item.id)) declined.delete(item.id); else declined.add(item.id); void showSetup(); });
      li.append(skip);
    }
    return li;
  }));
  $('#capability-list').replaceChildren(...body.capabilities.map(cap => el('li', `${cap.available ? '\u2713' : '\u2014'} ${cap.capability}: ${cap.reason}`)));
}
$('#open-setup').addEventListener('click', () => void showSetup());
$('#close-setup').addEventListener('click', () => { $('#setup').hidden = true; $('#task-list').hidden = false; renderedKey = undefined; render(); });
$('#archive-channel').addEventListener('click', () => {
  const name = $('#channel').value; if (!name) return;
  if (archive.has(name)) { archive.restore(name); notice(`Assunto ${name} restaurado na lista.`); }
  else { archive.archive(name); $('#channel').value = ''; notice(`Assunto ${name} arquivado nesta caixa. As tarefas e fontes continuam guardadas.`); }
  renderedKey = undefined; render();
});
$('#channel').addEventListener('change', () => { renderedKey = undefined; render(); });
$('#project').addEventListener('change', () => { renderedKey = undefined; render(); });
$('#refresh').addEventListener('click', () => sync(true));
$('#more').addEventListener('click', async () => {
  try {
    const page = await request(`/web/api/tasks?limit=100&cursor=${encodeURIComponent(lifecycle.cursor)}`);
    page.tasks.forEach(task => state.upsert(task)); lifecycle.nextPage(page.nextCursor); render();
  } catch { notice('Não foi possível carregar a próxima página. Use Atualizar.'); }
});
$('#more-events').addEventListener('click', async () => { try { await events(); render(); } catch { notice('Histórico indisponível. O cursor não avançou. Use Atualizar.'); } });
$('#create-form').addEventListener('submit', event => {
  event.preventDefault(); const title = $('#title').value.trim(); const channel = $('#new-channel').value.trim();
  if (title && channel) void mutate('/web/api/tasks', { title, channelId: channel });
});
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); const input = $('#token'); const value = input.value; input.value = '';
  const button = $('#login-form button'); button.disabled = true;
  try { await start(await request('/web/session', { token: value })); }
  catch { notice('Não foi possível entrar. Confira a chave e o serviço local. Muitas tentativas exigem aguardar um minuto.'); }
  finally { button.disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  try { await request('/web/session/logout', {}); signedOut(); notice('Sessão encerrada neste navegador.'); }
  catch { notice('Saída não confirmada. Feche o navegador ou tente sair novamente; a sessão pode continuar ativa.'); }
});
$('#theme').addEventListener('change', event => {
  const value = event.target.value;
  if (value === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
});
try { await start(await request('/web/session')); }
catch (error) { signedOut(); if (error.status !== 401) notice('Serviço local indisponível. Confira se ele foi iniciado por você.'); }
