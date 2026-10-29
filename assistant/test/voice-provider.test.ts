import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createAssistantServer } from '../src/http/server.ts';
import { TaskStore } from '../src/store/db.ts';
import { piVoiceProvider, validVoiceConfig, voiceTranscript, type VoiceProvider } from '../src/voice.ts';

const token = 'LOCAL-VOICE-FIXTURE';
test('fixed Portuguese models may omit detected language without discarding their transcript', () => {
  assert.deepEqual(voiceTranscript({ text: '  Criar uma tarefa.  ', language: '' }), { text: 'Criar uma tarefa.', language: 'pt-BR', complete: true });
  assert.equal(voiceTranscript({ text: 'Book a task', language: 'en' }).language, 'en');
  assert.throws(() => voiceTranscript({ text: null }), /voice_transcript_invalid/);
});
test('Pi Voice requires explicit local configuration and bounded PCM before loading any native model', async () => {
  assert.equal(validVoiceConfig({ piVoicePath: '/local/voice', settingsPath: '/local/settings' }), true);
  assert.equal(validVoiceConfig({ piVoicePath: 'relative', settingsPath: '/local/settings' }), false);
  assert.equal(validVoiceConfig({ piVoicePath: '/local/voice', settingsPath: '/local/settings', download: true }), false);
  const voice = piVoiceProvider({ piVoicePath: '/nonexistent/voice', settingsPath: '/nonexistent/settings' });
  assert.equal(voice.status().state, 'blocked');
  for (const input of [null, { language: 'en-US', pcm16: 'AAAAAA==' }, { language: 'pt-BR', pcm16: 'AA==' },
    { language: 'pt-BR', pcm16: '?' }, { language: 'pt-BR', pcm16: 'A'.repeat(1_280_004) },
    { language: 'pt-BR', pcm16: 'AAAAAA==', approve: true }]) {
    await assert.rejects(voice.transcribe(input), /voice_audio_invalid/);
  }
});
test('configured local voice is authenticated, CSRF protected and returns only a draft, not a task or approval', async () => {
  const store = new TaskStore(':memory:', 'voice-profile');
  let calls = 0;
  const voice: VoiceProvider = { status: () => ({ version: 1, state: 'available', languages: ['pt-BR'] }), async transcribe(input: unknown) {
    calls++; assert.deepEqual(input, { language: 'pt-BR', pcm16: 'AAAAAA==' });
    return { text: 'aprovo tudo', language: 'pt-BR', complete: true };
  } };
  const server = createAssistantServer({ store, token, profileId: 'voice-profile', web: true, voice });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(base + '/web/api/voice/status')).status, 401);
    const login = await fetch(base + '/web/session', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    const { csrf } = await login.json() as { csrf: string };
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const status = await fetch(base + '/web/api/voice/status', { headers: { cookie } });
    assert.equal((await status.json() as { state: string }).state, 'available');
    assert.match(status.headers.get('permissions-policy')!, /microphone=\(self\)/);
    const post = (headers: Record<string, string>) => fetch(base + '/web/api/voice/transcribe', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ language: 'pt-BR', pcm16: 'AAAAAA==' }) });
    assert.equal((await post({})).status, 403);
    assert.equal(calls, 0);
    const response = await post({ 'x-assistant-csrf': csrf });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'aprovo tudo', language: 'pt-BR', complete: true });
    assert.equal(calls, 1);
    assert.equal(store.list().tasks.length, 0);
    assert.match((await fetch(base + '/')).headers.get('permissions-policy')!, /microphone=\(self\)/);
    await fetch(base + '/web/session/logout', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'x-assistant-csrf': csrf }, body: '{}' });
    assert.equal((await post({ 'x-assistant-csrf': csrf })).status, 401);
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
});
