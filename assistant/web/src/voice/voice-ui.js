import { VoiceDraft, voiceMessages } from './voice.js';
import { browserMedia, localVoiceProvider } from './media.js';

const $ = selector => document.querySelector(selector);
const stateMessages = {
  idle: 'Pronto para gravar até 30 segundos. O navegador pedirá o microfone.',
  requesting: 'Aguardando permissão do microfone. Você pode cancelar.',
  recording: 'Gravando… Pare para transcrever ou cancele para descartar.',
  captured: 'Gravação encerrada após 30 segundos. Transcreva ou descarte.',
  transcribing: 'Transcrevendo localmente…',
  review: 'Revise a transcrição. Nada foi enviado ainda.',
  confirmed: 'Enviando o texto revisado…',
  sending: 'Enviando o texto revisado…',
  sent: 'Texto entregue ao painel como nova tarefa. Confira o aviso de resultado.',
  cancelled: 'Gravação cancelada. O áudio e o texto foram descartados.',
};
let draft;
let lifecycle = 0;

/** Reuse the configured Pi Voice model through the authenticated local service; no cloud upload. */
export async function startVoice(request, send) {
  stopVoice();
  const generation = lifecycle;
  let status;
  try { status = await request('/web/api/voice/status'); }
  catch { status = { version: 1, state: 'blocked', reason: 'provider_unavailable', languages: [] }; }
  if (lifecycle !== generation) return;
  draft = new VoiceDraft({ status, provider: status.state === 'available' ? localVoiceProvider(request) : null, media: browserMedia(), onSend: send, onChange: render });
  render();
}
export function stopVoice() {
  lifecycle++;
  if (draft && draft.state !== 'sending') draft.cancel();
  draft = undefined;
  $('#voice-review').hidden = true; $('#voice-transcript').value = '';
}
function render() {
  if (!draft) return;
  const blocked = draft.status?.state !== 'available';
  $('#voice-status').textContent = (draft.reason && voiceMessages[draft.reason]) || (blocked ? voiceMessages.provider_unavailable : stateMessages[draft.state]);
  $('#voice-record').disabled = blocked || !['idle', 'blocked', 'cancelled', 'failed', 'sent'].includes(draft.state);
  $('#voice-stop').hidden = !['recording', 'captured'].includes(draft.state);
  $('#voice-stop').textContent = draft.state === 'captured' ? 'Transcrever gravação' : 'Parar e transcrever';
  $('#voice-cancel').hidden = !['requesting', 'recording', 'captured', 'transcribing'].includes(draft.state);
  $('#voice-review').hidden = !['review', 'confirmed', 'sending'].includes(draft.state);
  if (draft.state === 'review' && document.activeElement !== $('#voice-transcript')) $('#voice-transcript').value = draft.transcript;
}
async function act(operation) {
  if (!draft) return;
  try { const pending = operation(draft); render(); await pending; }
  catch (error) { $('#voice-status').textContent = `Ação de voz recusada (${error.message}). Nada foi enviado.`; return; }
  render();
}
$('#voice-record').addEventListener('click', event => act(d => d.start(event)));
$('#voice-stop').addEventListener('click', event => act(d => d.stop(event)));
$('#voice-cancel').addEventListener('click', () => act(d => d.cancel()));
$('#voice-discard').addEventListener('click', () => act(d => d.cancel()));
$('#voice-transcript').addEventListener('input', event => { if (draft?.state === 'review') draft.edit(event.target.value); });
$('#voice-review').addEventListener('submit', event => {
  event.preventDefault();
  void act(async d => { d.confirm(event); await d.send(); });
});
