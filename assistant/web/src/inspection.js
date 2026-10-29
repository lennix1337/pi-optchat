const $ = selector => document.querySelector(selector);
let generation = 0;
let transport;
const states = { proposed: 'Proposta', measured: 'Medida', rejected: 'Rejeitada', approved: 'Aprovada', applied: 'Aplicada', reverted: 'Revertida' };
const noteStates = { pending: 'Pendente', suppressed: 'Sem consentimento', uncertain: 'Entrega incerta — não repetir', accepted: 'Transporte aceitou; leitura não confirmada', read: 'Lido', failed: 'Falhou' };
function el(tag, text) { const n = document.createElement(tag); n.textContent = text; return n; }
function render(value) {
  const learning = $('#learning-content'), notices = $('#delivery-content'), restored = $('#restored-content');
  learning.replaceChildren(); notices.replaceChildren(); restored.replaceChildren();
  $('#workspace-note').textContent = value.learning && value.learning.current.revision > 0 ? value.learning.current.text : '';
  if (!value.learning) learning.append(el('p', 'Aprendizado de apresentação não ativado neste serviço.'));
  else {
    learning.append(el('p', `Texto atual: ${value.learning.current.text} · revisão ${value.learning.current.revision}`));
    if (!value.learning.proposals.length) learning.append(el('p', 'Nenhuma proposta. A criação e as decisões são feitas pelo comando local display-learning.mjs, com revisão explícita.'));
    for (const proposal of value.learning.proposals) {
      const item = el('article', '');
      item.append(el('strong', `${states[proposal.state]} · ${proposal.profileId} · v${proposal.version}`), el('p', proposal.candidate), el('p', `Proposta ${proposal.id} · hash ${proposal.candidateHash}`));
      if (proposal.measurement) {
        const m = proposal.measurement;
        item.append(el('p', `Cobertura sintética: ${m.baseline.score}/${m.baseline.total} → ${m.candidate.score}/${m.candidate.total}. Não mede eficácia pessoal.`), el('p', `Conjunto: ${m.datasetId} · ${m.datasetHash}`));
      }
      learning.append(item);
    }
  }
  if (!value.restored.length) restored.append(el('p', 'Nenhuma tarefa retida por restauração.'));
  else {
    restored.append(el('p', 'Restauradas do backup: o executor não gera nem repete nada para elas. O original pode ter agido depois do backup. Confira e encerre com executor.mjs restored/reconcile; depois recoloque na fila.'));
    for (const hold of value.restored) restored.append(el('p', `${hold.status === 'queued' ? 'Na fila' : 'Em andamento'} · ${hold.title} · revisão ${hold.revision} · ${hold.taskId}`));
  }
  if (!value.notices) notices.append(el('p', 'Notificações não ativadas neste serviço.'));
  else if (!value.notices.length) notices.append(el('p', 'Nenhum aviso registrado.'));
  else for (const note of value.notices) notices.append(el('p', `${noteStates[note.state]} · ${note.category} · referência ${note.ref}${note.reason ? ` · ${note.reason}` : ''}`));
}
async function load() {
  if (!transport) return;
  const current = generation; $('#inspection-load').disabled = true;
  $('#inspection-status').textContent = 'Consultando o estado guardado…';
  try {
    const value = await transport('/web/api/inspection');
    if (current !== generation) return;
    render(value); $('#inspection-status').textContent = 'Consulta somente de leitura. Nenhuma proposta aprovada ou aviso reenviado.';
  } catch (error) {
    if (current !== generation) return;
    $('#learning-content').replaceChildren(); $('#delivery-content').replaceChildren(); $('#restored-content').replaceChildren(); $('#workspace-note').textContent = '';
    $('#inspection-status').textContent = error.status === 401 ? 'Sessão encerrada. Entre novamente.' : 'Estado indisponível. Nada foi alterado; tente consultar novamente.';
  } finally { if (current === generation) $('#inspection-load').disabled = false; }
}
export function startInspection(request) { stopInspection(); transport = request; void load(); }
export function stopInspection() {
  generation++; transport = undefined;
  $('#workspace-note').textContent = ''; $('#learning-content').replaceChildren(); $('#delivery-content').replaceChildren(); $('#restored-content').replaceChildren();
  $('#inspection-status').textContent = ''; $('#inspection-load').disabled = false; $('#inspection').open = false;
}
$('#inspection-load').addEventListener('click', () => void load());
