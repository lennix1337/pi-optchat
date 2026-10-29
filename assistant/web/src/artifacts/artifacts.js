const $ = selector => document.querySelector(selector);
export const typeLabels = { document: 'Documento', slides: 'Apresentação', page: 'Página', dashboard: 'Painel de dados', design: 'Design', design_system: 'Design system' };
export const reviewLabels = { not_reviewed: 'Revisão pendente', approved: 'Revisão: aprovado', rejected: 'Revisão: rejeitado' };
let request;
let generation = 0;
let opener;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const status = message => { $('#artifacts-status').textContent = message; };
const versionPath = artifact => `/web/api/artifacts/${encodeURIComponent(artifact.artifactId)}/versions/${artifact.artifactVersion}`;
const describe = artifact => `${artifact.fileName}, versão ${artifact.artifactVersion}`;

/** `send` is the panel's authenticated JSON request (cookie + CSRF); artifact bytes never pass through this page. */
export function startArtifacts(send) { request = send; generation++; void load(); }
export function stopArtifacts() {
  request = undefined; generation++;
  closePreview(false);
  $('#artifact-list').replaceChildren(); status('');
}
async function load() {
  if (!request) return;
  const current = generation;
  const type = $('#artifact-type').value;
  status('Carregando artefatos…');
  try {
    const page = await request(`/web/api/artifacts${type ? `?type=${encodeURIComponent(type)}` : ''}`);
    if (current !== generation) return;
    $('#artifact-list').replaceChildren(...page.artifacts.map(card));
    const count = page.artifacts.length;
    status(count ? `${count} artefato${count > 1 ? 's' : ''}${page.more ? ' (os mais recentes; há outros)' : ''}. Revisar não autoriza envio.` : 'Nenhum artefato registrado neste filtro.');
  } catch (error) {
    if (current !== generation) return;
    status(error.status === 503 ? 'Artefatos não configurados neste serviço.' : error.status === 401 ? 'Sessão encerrada. Entre novamente.' : 'Não foi possível carregar os artefatos. Nada foi alterado.');
  }
}
function card(artifact) {
  const article = el('article', undefined, 'artifact-card'); article.dataset.artifactId = artifact.artifactId;
  const meta = el('p', undefined, 'task-meta');
  meta.append(el('span', typeLabels[artifact.type] ?? artifact.type, 'task-status'), el('span', `versão ${artifact.artifactVersion}`), el('span', reviewLabels[artifact.review]));
  const facts = el('dl');
  for (const [term, value] of [['Produzido por', artifact.producerId], ['Origem', artifact.provenance], ['SHA-256', artifact.hash]]) {
    facts.append(el('dt', term), el('dd', value));
  }
  article.append(meta, el('h3', artifact.fileName), facts, actions(artifact, true));
  const versions = el('details', undefined, 'artifact-versions');
  versions.append(el('summary', 'Versões anteriores'));
  versions.addEventListener('toggle', () => { if (versions.open && versions.childElementCount === 1) void loadVersions(artifact, versions); });
  if (artifact.artifactVersion > 1) article.append(versions);
  return article;
}
function actions(artifact, withReview) {
  const controls = el('div', undefined, 'task-actions');
  const open = el('button', 'Abrir prévia'); open.setAttribute('aria-label', `Abrir prévia de ${describe(artifact)}`);
  open.addEventListener('click', () => openPreview(artifact, open));
  const download = el('a', 'Baixar', 'button-link'); download.href = `${versionPath(artifact)}/download`; download.setAttribute('download', artifact.fileName);
  download.setAttribute('aria-label', `Baixar ${describe(artifact)}`);
  controls.append(open, download);
  if (withReview && artifact.review === 'not_reviewed') {
    for (const [decision, label] of [['approved', 'Aprovar revisão'], ['rejected', 'Rejeitar revisão']]) {
      const button = el('button', label); button.setAttribute('aria-label', `${label}: ${describe(artifact)}`);
      button.addEventListener('click', () => review(artifact, decision, controls));
      controls.append(button);
    }
  }
  return controls;
}
async function loadVersions(artifact, details) {
  try {
    const { versions } = await request(`/web/api/artifacts/${encodeURIComponent(artifact.artifactId)}`);
    const list = el('ol');
    for (const version of versions.filter(item => item.artifactVersion !== artifact.artifactVersion).reverse()) {
      const item = el('li');
      item.append(el('p', `Versão ${version.artifactVersion} · ${reviewLabels[version.review]} · ${new Date(version.createdAt).toLocaleString('pt-BR')}`), actions(version, false));
      list.append(item);
    }
    details.append(list);
  } catch { details.append(el('p', 'Não foi possível carregar as versões.', 'hint')); }
}
async function review(artifact, decision, controls) {
  controls.querySelectorAll('button').forEach(button => { button.disabled = true; });
  let message;
  try {
    await request(`${versionPath(artifact)}/review`, { decision });
    message = `Revisão registrada para ${describe(artifact)}. Isso não autoriza nenhum envio.`;
  } catch (error) {
    message = error.status === 409 ? 'Esta versão já foi revisada. Confira o estado atual.' : 'Revisão não confirmada. Atualize antes de tentar outra vez.';
  }
  await load();
  status(message);
}
async function openPreview(artifact, button) {
  try {
    const { url } = await request(`${versionPath(artifact)}/preview`, {});
    opener = button;
    $('#preview-title').textContent = `Prévia: ${describe(artifact)}`;
    $('#preview-frame').src = url;
    $('#artifact-preview').hidden = false;
    $('#preview-title').focus();
  } catch (error) {
    status(error.status === 409 ? 'Este arquivo mudou ou saiu do local registrado; a prévia foi recusada.' : 'Não foi possível abrir a prévia.');
  }
}
function closePreview(restoreFocus = true) {
  $('#preview-frame').src = 'about:blank';
  $('#artifact-preview').hidden = true;
  if (restoreFocus && opener?.isConnected) opener.focus();
  opener = undefined;
}
$('#artifact-type').addEventListener('change', () => { void load(); });
$('#artifacts-refresh').addEventListener('click', () => { void load(); });
$('#preview-close').addEventListener('click', () => closePreview());
