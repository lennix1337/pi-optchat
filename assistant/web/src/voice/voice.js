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
  constructor({ status, provider, media, onSend, language = 'pt-BR', maxLength = 200 }) {
    this.status = status; this.provider = provider; this.media = media; this.onSend = onSend;
    this.language = language; this.maxLength = maxLength;
    this.state = 'idle'; this.reason = null; this.transcript = ''; this.confirmed = null; this.audio = null; this.recording = null;
  }
  async start(gesture) {
    if (!restartable.has(this.state)) throw new Error('voice_busy');
    if (!humanGesture(gesture)) throw new Error('consent_requires_human_gesture');
    this.reason = null; this.transcript = ''; this.confirmed = null;
    if (this.status?.state !== 'available' || !this.provider) return this.end('blocked', 'provider_unavailable');
    if (!this.status.languages?.includes(this.language)) return this.end('blocked', 'language_unsupported');
    if (!this.media?.getUserMedia) return this.end('blocked', 'microphone_unavailable');
    let stream;
    try { stream = await this.media.getUserMedia({ audio: true }); }
    catch (error) { return this.end('blocked', error?.name === 'NotAllowedError' ? 'microphone_denied' : 'microphone_unavailable'); }
    this.recording = { stream, recorder: this.media.record(stream) };
    this.state = 'recording';
  }
  async stop(gesture) {
    if (this.state !== 'recording') throw new Error('not_recording');
    if (!humanGesture(gesture)) throw new Error('stop_requires_human_gesture');
    const { stream, recorder } = this.recording;
    this.recording = null; this.state = 'transcribing';
    try { this.audio = await recorder.stop(); }
    catch { stopTracks(stream); return this.end('failed', 'capture_failed'); }
    stopTracks(stream);
    if (this.state !== 'transcribing') { this.audio = null; return; }
    let result;
    try { result = await this.provider.transcribe(this.audio, this.language); }
    catch { result = null; }
    finally { this.audio = null; }
    if (this.state !== 'transcribing') return;
    if (!result) return this.end('failed', 'transcription_failed');
    if (result.language !== this.language) return this.end('failed', 'language_mismatch');
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!text) return this.end('failed', 'no_speech');
    if (result.complete !== true) return this.end('failed', 'transcription_incomplete');
    this.transcript = text; this.state = 'review';
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
    if (this.recording) { stopTracks(this.recording.stream); this.recording = null; }
    this.end('cancelled', null);
  }
  end(state, reason) {
    this.state = state; this.reason = reason; this.transcript = ''; this.confirmed = null; this.audio = null;
  }
}
function stopTracks(stream) { for (const track of stream?.getTracks?.() ?? []) track.stop(); }
