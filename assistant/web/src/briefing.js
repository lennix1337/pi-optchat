import { readAt } from './time.js';

const $ = selector => document.querySelector(selector);
let generation = 0;
let request;
const uncertainty = { low: 'baixa', medium: 'média', high: 'alta' };
const sourceState = { ok: 'disponível', partial: 'parcial', unavailable: 'indisponível' };
function node(tag, text) { const n = document.createElement(tag); n.textContent = text; return n; }

function renderMeetingPrep(cards) {
  const list = node('ol', '');
  for (const card of cards) {
    const li = node('li', '');
    const people = card.attendees.map(person => person.displayName || person.email).join(', ');
    const threads = card.threads.map(thread => thread.subject).join('; ') || 'Nenhuma encontrada';
    const open = card.openItems.map(item => `${item.title} (${item.reason === 'unread_thread' ? 'não lida' : 'tarefa aberta'})`).join('; ') || 'Nenhum encontrado';
    li.append(node('strong', card.title), node('p', `${card.when}${card.allDay ? ' · dia inteiro' : ''} · ${people}`), node('p', `Conversas recentes: ${threads}`), node('p', `Itens em aberto: ${open}`));
    list.append(li);
  }
  return list;
}

/** Sources stay text, not executable links or commands. Reading a stored summary starts no work. */
export function renderBriefing(root, value) {
  root.replaceChildren();
  root.append(node('p', `${value.kind === 'daily' ? 'Diário' : 'Sob demanda'} · ${value.localDate} · ${value.timeZone} · leitura em ${readAt(value.createdAt, value.timeZone)}`));
  const sources = node('ul', '');
  for (const source of value.sources) sources.append(node('li', `${source.sourceId}: ${sourceState[source.state]}${source.error ? ` (${source.error})` : ''}`));
  root.append(sources);
  if (value.meetingPrep?.length) root.append(node('h3', 'Preparo para reuniões · próximas 24 horas'), renderMeetingPrep(value.meetingPrep));
  const items = node('ol', '');
  for (const item of value.items) {
    const li = node('li', '');
    li.append(node('strong', item.title), node('p', `${item.urgency} · ${item.reason} · incerteza ${uncertainty[item.uncertainty]}`), node('p', `Fonte: ${item.sourceRef}`));
    if (item.step?.kind === 'reply_draft') li.append(node('p', `Rascunho local não enviado: ${item.step.subject} (${item.step.draftId})`));
    else if (item.step?.kind === 'next') li.append(node('p', `Próximo passo: ${item.step.text}`));
    items.append(li);
  }
  root.append(items, node('p', `${value.distractions} mensagens omitidas. Ler este resumo não inicia nenhuma ação.`));
  if (value.ruleEffects?.length) {
    const rules = node('ul', '');
    for (const rule of value.ruleEffects) rules.append(node('li', `Regra ${rule.ruleId}: ocultou ${rule.hidden} · ${rule.reason}`));
    root.append(rules);
  }
}
async function load() {
  if (!request) return;
  const current = generation;
  const button = $('#briefing-load');
  button.disabled = true;
  $('#briefing-status').textContent = 'Lendo o último resumo guardado…';
  try {
    const value = await request('/web/api/briefing');
    if (current !== generation) return;
    renderBriefing($('#briefing-content'), value);
    $('#briefing-status').textContent = 'Dados guardados; podem estar desatualizados. Nenhuma nova leitura do Google foi feita.';
  } catch (error) {
    if (current !== generation) return;
    $('#briefing-content').replaceChildren();
    $('#briefing-status').textContent = error.status === 404 ? 'Nenhum resumo guardado ou Google não configurado neste serviço.' : error.status === 401 ? 'Sessão encerrada. Entre novamente para ler.' : 'Não foi possível ler o resumo. Tente novamente; nada foi iniciado.';
  } finally { if (current === generation) button.disabled = false; }
}
export function startBriefing(transport) { stopBriefing(); request = transport; }
export function stopBriefing() {
  generation++; request = undefined;
  $('#briefing-content').replaceChildren(); $('#briefing-status').textContent = '';
  $('#briefing-load').disabled = false; $('#briefing').open = false;
}
$('#briefing-load').addEventListener('click', () => void load());
