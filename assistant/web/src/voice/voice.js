/** Explanations for every state in which nothing is recorded or sent. */
export const voiceMessages = {
  provider_unavailable: 'Voz indisponível: nenhum transcritor local em português está configurado neste serviço. Nada é gravado nem enviado.',
  language_unsupported: 'O transcritor local não oferece português. Nada foi gravado.',
  microphone_unavailable: 'Nenhum microfone disponível neste navegador. Nada foi gravado.',
  microphone_denied: 'O acesso ao microfone foi negado. Nada foi gravado.',
  capture_failed: 'A gravação falhou. O áudio foi descartado e nada foi enviado.',
  transcription_failed: 'A transcrição falhou. O áudio foi descartado e nenhum texto foi enviado.',
  transcription_incomplete: 'A transcrição ficou incompleta. O texto parcial e o áudio foram descartados; nada foi enviado.',
  no_speech: 'Nenhuma fala reconhecida (silêncio ou ruído). O áudio foi descartado e nada foi enviado.',
  language_mismatch: 'A transcrição não veio em português. O áudio foi descartado e nada foi enviado.',
};
const gestures = new Set(['click', 'keydown', 'keyup', 'pointerup', 'submit']);
/** Consent and confirmation come only from trusted local input events, never from audio, transcript text or script. */
export function humanGesture(event) { return event?.isTrusted === true && gestures.has(event.type); }
const restartable = new Set(['idle', 'blocked', 'cancelled', 'failed', 'sent']);

/**
 * Voice-to-message draft: capture starts only from a human gesture, audio lives in memory only until it is
 * transcribed or cancelled, and the transcript is a message draft that is sent once, only after a human
 * confirms the exact reviewed text. Nothing a transcript says is consent or approval.
 */
export class VoiceDraft {
  constructor({ status, provider, media, onSend, onChange = () => {}, language = 'pt-BR', maxLength = 200 }) {
    this.status = status; this.provider = provider; this.media = media; this.onSend = onSend;
    this.language = language; this.maxLength = maxLength; this.onChange = onChange;
    this.captureGeneration = 0;
    this.state = 'idle'; this.reason = null; this.transcript = ''; this.confirmed = null; this.audio = null; this.recording = null;
  }
  async start(gesture) {
    if (!restartable.has(this.state)) throw new Error('voice_busy');
    if (!humanGesture(gesture)) throw new Error('consent_requires_human_gesture');
    this.reason = null; this.transcript = ''; this.confirmed = null;
    if (this.status?.state !== 'available' || !this.provider) return this.end('blocked', 'provider_unavailable');
    if (!this.status.languages?.includes(this.language)) return this.end('blocked', 'language_unsupported');
    if (!this.media?.getUserMedia) return this.end('blocked', 'microphone_unavailable');
    return requestCapture(this);
  }
  async stop(gesture) {
    if (this.state !== 'recording' && this.state !== 'captured') throw new Error('not_recording');
    if (!humanGesture(gesture)) throw new Error('stop_requires_human_gesture');
    return finishCapture(this);
  }
  edit(text) {
    if (this.state !== 'review' && this.state !== 'confirmed') throw new Error('not_reviewing');
    this.transcript = String(text); this.confirmed = null; this.state = 'review';
  }
  confirm(gesture) {
    if (this.state !== 'review') throw new Error('not_reviewing');
    if (!humanGesture(gesture)) throw new Error('confirmation_requires_human_gesture');
    const text = this.transcript.trim();
    if (!text || text.length > this.maxLength) throw new Error('transcript_invalid');
    this.confirmed = text; this.state = 'confirmed';
  }
  async send() {
    if (this.state !== 'confirmed') throw new Error('confirmation_required');
    // Only the text the human confirmed is sent; editing returns the draft to review.
    const text = this.confirmed;
    this.state = 'sending';
    try { await this.onSend({ kind: 'message', text }); }
    catch (error) { this.state = 'review'; this.confirmed = null; throw error; }
    this.state = 'sent'; this.transcript = ''; this.confirmed = null;
  }
  cancel() {
    if (this.state === 'sending') throw new Error('voice_sending');
    this.captureGeneration++;
    this.controller?.abort();
    if (this.recording) { this.recording.recorder.cancel?.(); stopTracks(this.recording.stream); this.recording = null; }
    this.end('cancelled', null);
  }
  end(state, reason) {
    this.state = state; this.reason = reason; this.transcript = ''; this.confirmed = null; this.audio = null;
  }
}
async function requestCapture(draft) {
  let stream;
  const generation = ++draft.captureGeneration;
  draft.controller = new AbortController();
  draft.state = 'requesting';
  try { stream = await draft.media.getUserMedia({ audio: true }); }
  catch (error) { if (draft.state === 'requesting' && draft.captureGeneration === generation) draft.end('blocked', error?.name === 'NotAllowedError' ? 'microphone_denied' : 'microphone_unavailable'); return; }
  if (draft.state !== 'requesting' || draft.captureGeneration !== generation) { stopTracks(stream); return; }
  try { draft.recording = { stream, recorder: draft.media.record(stream, error => {
    if (draft.captureGeneration !== generation || draft.state !== 'recording') return;
    if (error) { draft.recording = null; draft.end('failed', 'capture_failed'); }
    else draft.state = 'captured';
    draft.onChange();
  }) }; }
  catch { stopTracks(stream); return draft.end('failed', 'capture_failed'); }
  draft.state = 'recording';
}

async function finishCapture(draft) {
  const generation = draft.captureGeneration;
  const signal = draft.controller.signal;
  const { stream, recorder } = draft.recording;
  draft.recording = null; draft.state = 'transcribing';
  let audio;
  try { audio = await recorder.stop(); }
  catch { stopTracks(stream); if (draft.captureGeneration === generation) draft.end('failed', 'capture_failed'); return; }
  stopTracks(stream);
  if (draft.state !== 'transcribing' || draft.captureGeneration !== generation) return;
  return transcribeCapture(draft, audio, generation, signal);
}

async function transcribeCapture(draft, audio, generation, signal) {
  draft.audio = audio;
  let result;
  try { result = await draft.provider.transcribe(audio, draft.language, signal); }
  catch { result = null; }
  finally { if (draft.captureGeneration === generation) draft.audio = null; }
  if (draft.state !== 'transcribing' || draft.captureGeneration !== generation) return;
  return reviewTranscription(draft, result);
}

function reviewTranscription(draft, result) {
  if (!result) return draft.end('failed', 'transcription_failed');
  if (result.language !== draft.language) return draft.end('failed', 'language_mismatch');
  const text = typeof result.text === 'string' ? result.text.trim() : '';
  if (!text) return draft.end('failed', 'no_speech');
  if (result.complete !== true) return draft.end('failed', 'transcription_incomplete');
  draft.transcript = text; draft.state = 'review';
}

function stopTracks(stream) { for (const track of stream?.getTracks?.() ?? []) track.stop(); }
