import { PanelState, actions, attention, labels } from './state.js';

const $ = selector => document.querySelector(selector);
let state;
let csrf;
let filter = 'attention';
let selectedTask;
let nextCursor = null;
let timer;
let syncing = false;
let uncertain = false;
let mutationPending = false;
let pendingRequest;
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
  $('#workspace').hidden = true; $('#logout').hidden = true; $('#login').hidden = false;
  $('#task-list').replaceChildren(); $('#evidence-list').replaceChildren();
}
async function start(session) {
  csrf = session.csrf; state = new PanelState(session.profileId);
  $('#login').hidden = true; $('#workspace').hidden = false; $('#logout').hidden = false;
  $('#profile').textContent = `Perfil ${session.profileId} · serviço local`;
  nextCursor = null; selectedTask = undefined; uncertain = false; renderedKey = undefined;
  await sync(true);
}
async function sync(manual = false) {
  if (!state || syncing) return;
  syncing = true; clearTimeout(timer);
  try {
    const page = await request('/web/api/tasks?limit=100');
    for (const task of page.tasks) state.upsert(task);
    nextCursor = page.nextCursor;
    await events();
    if (uncertain && pendingRequest && state.events.some(entry => entry.event.source.sourceEventId === pendingRequest)) {
      uncertain = false; pendingRequest = undefined;
      notice('A ação anterior foi encontrada no histórico. Confira o resultado antes de continuar.');
    } else if (manual && !uncertain) notice('');
    $('#create-form button').disabled = uncertain;
    $('#connection').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')} · evento ${state.after}`;
    // Do not replace a form while the operator is typing. Its revision stays bound to that visible decision.
    if (manual || !$('#task-list').contains(document.activeElement)) render();
  } catch (error) {
    if (error.status === 401) { signedOut(); notice('Sessão encerrada. Entre novamente.'); }
    else { $('#connection').textContent = 'Sem conexão · estado pode estar desatualizado'; notice('Não foi possível atualizar. Nenhuma ação será reenviada automaticamente.'); }
  } finally {
    syncing = false;
    if (state) timer = setTimeout(() => sync(), 5000);
  }
}
async function events() {
  const entries = await request(`/web/api/events?after=${state.after}&limit=100`);
  state.apply(entries); $('#more-events').hidden = entries.length < 100;
  renderEvidence();
}
function channelOptions() {
  const select = $('#channel'); const selected = select.value;
  const channels = [...new Set(state.channels.values())].sort();
  select.replaceChildren(new Option('Todos os assuntos', ''), ...channels.map(name => new Option(name, name)));
  if (channels.includes(selected)) select.value = selected;
}
function render() {
  if (!state) return;
  const key = `${state.revision}:${filter}:${$('#channel').value}:${uncertain}:${mutationPending}:${nextCursor}`;
  if (key === renderedKey) return;
  renderedKey = key;
  channelOptions();
  const tasks = [...state.tasks.values()];
  $('#attention-count').textContent = String(tasks.filter(attention).length);
  const selected = $('#channel').value;
  const visible = tasks.filter(task => {
    if (selected && state.channels.get(task.taskId) !== selected) return false;
    if (filter === 'attention') return attention(task);
    if (filter === 'active') return ['queued', 'working'].includes(task.status);
    if (filter === 'archive') return task.status === 'resolved';
    return task.status !== 'resolved';
  }).sort((a, b) => Number(attention(b)) - Number(attention(a)) || a.title.localeCompare(b.title, 'pt-BR'));
  const list = $('#task-list');
  list.replaceChildren(...visible.map(card));
  if (!visible.length) {
    const empty = el('div', undefined, 'empty');
    empty.append(el('h2', filter === 'attention' ? 'Nenhuma decisão esperando.' : 'Nenhuma tarefa nesta vista.'), el('p', 'O estado mostrado vem deste perfil. Você pode mudar a vista ou colocar uma tarefa na fila.'));
    list.append(empty);
  }
  $('#more').hidden = !nextCursor;
  $('#more').disabled = syncing;
}
function card(task) {
  const article = el('article', undefined, 'task'); article.dataset.taskId = task.taskId;
  const meta = el('div', undefined, 'task-meta');
  meta.append(el('span', labels[task.status], 'task-status'), el('span', state.channels.get(task.taskId) ?? 'Canal não carregado'), el('span', `rev. ${task.revision}`));
  article.append(meta, el('h3', task.title));
  const verification = { verified: 'Verificado', not_verified: 'Resultado não verificado', blocked: 'Verificação bloqueada' };
  article.append(el('p', verification[task.verification], 'task-verification'));
  const details = el('details'); details.append(el('summary', 'Identidade da tarefa'), el('p', `${task.taskId} · origem ${task.sourceEventId}`)); article.append(details);
  if (task.status === 'needs_input') article.append(responseForm(task));
  if (task.status === 'ready_for_review') article.append(el('p', 'Aceitar muda o estado da tarefa; não autoriza um envio nem verifica um efeito externo.', 'hint'));
  const controls = el('div', undefined, 'task-actions');
  for (const [nextStatus, label] of actions[task.status] ?? []) {
    const button = el('button', label); button.disabled = uncertain || mutationPending;
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
  const label = el('label', `Sua resposta · pedido ${task.inputRevision}`); label.htmlFor = id;
  const input = el('textarea'); input.id = id; input.required = true; input.maxLength = 4000;
  const button = el('button', 'Responder ao pedido atual', 'primary'); button.type = 'submit'; button.disabled = uncertain || mutationPending;
  form.append(label, input, button);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!input.value.trim()) return;
    void mutate(`/web/api/tasks/${encodeURIComponent(task.taskId)}/respond`, { revision: task.revision, inputRevision: task.inputRevision, text: input.value });
  });
  return form;
}
async function mutate(path, input) {
  if (uncertain || mutationPending) return;
  mutationPending = true;
  document.querySelectorAll('.task-actions button, .response-form button, #create-form button').forEach(button => { button.disabled = true; });
  try {
    pendingRequest = crypto.randomUUID();
    const task = await request(path, { requestId: pendingRequest, channelId, ...input });
    state.upsert(task); pendingRequest = undefined;
    notice('Estado salvo. Nenhum efeito externo foi autorizado.');
    if (path === '/web/api/tasks') { $('#title').value = ''; filter = 'active'; updateFilters(); }
    await events();
  } catch (error) {
    if (error.status === 409) {
      if (error.body.task) state.upsert(error.body.task);
      notice('Esta decisão já mudou. Revise o estado atual antes de responder outra vez.');
    } else if (error.status === 401) { signedOut(); notice('Sessão encerrada. Entre novamente.'); }
    else {
      uncertain = true;
      notice('Resultado não confirmado. Não repita o clique: use Atualizar para procurar a ação no histórico. As ações ficam bloqueadas até a confirmação.');
    }
  } finally {
    mutationPending = false;
    $('#create-form button').disabled = uncertain;
    render();
  }
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
$('#channel').addEventListener('change', render);
$('#refresh').addEventListener('click', () => sync(true));
$('#more').addEventListener('click', async () => {
  try {
    const page = await request(`/web/api/tasks?limit=100&cursor=${encodeURIComponent(nextCursor)}`);
    page.tasks.forEach(task => state.upsert(task)); nextCursor = page.nextCursor; render();
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
