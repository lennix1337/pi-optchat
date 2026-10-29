const sampleRate = 16_000;
const maxSeconds = 30;

/** Same-origin local transcription input: mono PCM16, 16 kHz, at most 30 seconds. No file persists. */
export async function pcm16Audio(blob, signal) {
  signal?.throwIfAborted();
  const decoder = new AudioContext();
  let decoded;
  try { decoded = await decoder.decodeAudioData(await blob.arrayBuffer()); }
  finally { await decoder.close(); }
  signal?.throwIfAborted();
  if (decoded.duration > maxSeconds + 0.5) throw new Error('voice_audio_too_long');
  const count = Math.min(sampleRate * maxSeconds, Math.floor(decoded.duration * sampleRate));
  if (!count) throw new Error('voice_audio_empty');
  const offline = new OfflineAudioContext(1, count, sampleRate);
  const source = offline.createBufferSource();
  source.buffer = decoded; source.connect(offline.destination); source.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  signal?.throwIfAborted();
  const bytes = new Uint8Array(count * 2); const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) view.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), true);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function browserMedia() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return null;
  return {
    getUserMedia: constraints => navigator.mediaDevices.getUserMedia(constraints),
    record(stream, onStopped) {
      const recorder = new MediaRecorder(stream);
      let chunks = []; let discard = false;
      let resolve; let reject;
      const audio = new Promise((yes, no) => { resolve = yes; reject = no; });
      // Cancellation may happen without anyone awaiting stop().
      void audio.catch(() => {});
      const stopTracks = () => { for (const track of stream.getTracks()) track.stop(); };
      const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); stopTracks(); };
      const timer = setTimeout(stop, maxSeconds * 1000);
      recorder.addEventListener('dataavailable', event => { if (!discard) chunks.push(event.data); });
      recorder.addEventListener('stop', () => {
        clearTimeout(timer); stopTracks();
        resolve(discard ? null : new Blob(chunks, { type: recorder.mimeType })); chunks = [];
        if (!discard) onStopped?.();
      }, { once: true });
      recorder.addEventListener('error', () => { clearTimeout(timer); discard = true; stopTracks(); chunks = []; reject(new Error('capture_failed')); onStopped?.(new Error('capture_failed')); }, { once: true });
      recorder.start();
      return { async stop() { stop(); return audio; }, cancel() { discard = true; chunks = []; stop(); } };
    },
  };
}

export function localVoiceProvider(request, encode = pcm16Audio) {
  return { async transcribe(audio, language, signal) {
    signal?.throwIfAborted();
    const pcm16 = await encode(audio, signal);
    signal?.throwIfAborted();
    return request('/web/api/voice/transcribe', { language, pcm16 }, { signal });
  } };
}
