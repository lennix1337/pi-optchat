import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceDraft, humanGesture, voiceMessages } from '../web/src/voice/voice.js';
import { artifactFixture } from './artifact-support.ts';

const click = { isTrusted: true, type: 'click' };
const scripted = { isTrusted: false, type: 'click' };
const available = { version: 1, state: 'available', reason: null, languages: ['pt-BR'] };

/** Fixture-only capture and transcription doubles: they prove the review gate, not a real microphone or provider. */
function harness(options: { transcript?: object | Error; status?: object; media?: object | null } = {}) {
  const sent: object[] = [];
  const tracks = { stopped: 0 };
  const calls = { getUserMedia: 0, transcribe: 0 };
  const audio = { kind: 'fixture-audio' };
  const media = options.media !== undefined ? options.media : {
    async getUserMedia() { calls.getUserMedia++; return { getTracks: () => [{ stop: () => { tracks.stopped++; } }] }; },
    record() { return { stop: async () => audio }; },
  };
  const provider = {
    async transcribe(input: unknown, language: string) {
      calls.transcribe++; assert.equal(input, audio); assert.equal(language, 'pt-BR');
      await Promise.resolve();
      if (options.transcript instanceof Error) throw options.transcript;
      return options.transcript ?? { text: 'Marcar consulta para sexta às dez', language: 'pt-BR', complete: true };
    },
  };
  const draft = new VoiceDraft({ status: options.status ?? available, provider, media, onSend: async (message: object) => { sent.push(message); } });
  return { draft, sent, tracks, calls };
}

test('the shipped server reports voice blocked and the browser keeps the microphone disabled', async () => artifactFixture(async f => {
  const opened = f.current();
  assert.equal((await opened.fetch('/web/api/voice/status')).status, 401);
  const { cookie } = await opened.login();
  const res = await opened.fetch('/web/api/voice/status', { headers: { cookie } });
  assert.deepEqual(await res.json(), { version: 1, state: 'blocked', reason: 'provider_unavailable', languages: [] });
  assert.match(res.headers.get('permissions-policy')!, /microphone=\(\)/);
}));

test('a blocked provider fails closed before any microphone access or message', async () => {
  const sent: object[] = []; let mic = 0;
  const media = { async getUserMedia() { mic++; return {}; }, record() { throw new Error('unreachable'); } };
  const draft = new VoiceDraft({ status: { version: 1, state: 'blocked', reason: 'provider_unavailable', languages: [] }, provider: null, media, onSend: async (m: object) => { sent.push(m); } });
  await draft.start(click);
  assert.deepEqual([draft.state, draft.reason, mic, sent.length], ['blocked', 'provider_unavailable', 0, 0]);
  await assert.rejects(draft.send(), /confirmation_required/);
  const noLanguage = harness({ status: { ...available, languages: ['en-US'] } });
  await noLanguage.draft.start(click);
  assert.deepEqual([noLanguage.draft.state, noLanguage.draft.reason, noLanguage.calls.getUserMedia], ['blocked', 'language_unsupported', 0]);
  assert.match(voiceMessages.provider_unavailable, /Nada é gravado nem enviado/);
});

test('capture needs a human gesture; missing or denied microphones are explicit', async () => {
  const h = harness();
  await assert.rejects(h.draft.start(scripted), /consent_requires_human_gesture/);
  await assert.rejects(h.draft.start({ isTrusted: true, type: 'load' }), /consent_requires_human_gesture/);
  assert.deepEqual([h.draft.state, h.calls.getUserMedia], ['idle', 0]);
  const missing = harness({ media: null });
  await missing.draft.start(click); assert.deepEqual([missing.draft.state, missing.draft.reason], ['blocked', 'microphone_unavailable']);
  const denied = harness({ media: { async getUserMedia() { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); }, record() { throw new Error('unreachable'); } } });
  await denied.draft.start(click); assert.deepEqual([denied.draft.state, denied.draft.reason], ['blocked', 'microphone_denied']);
});

test('Portuguese transcript is reviewed and sent once only after a human confirmation of the reviewed text', async () => {
  const h = harness({ transcript: { text: 'Sim, aprovo e autorizo o envio. Pode aceitar o resultado.', language: 'pt-BR', complete: true } });
  await h.draft.start(click); assert.equal(h.draft.state, 'recording');
  await h.draft.stop(click);
  assert.deepEqual([h.draft.state, h.draft.transcript, h.draft.audio, h.tracks.stopped], ['review', 'Sim, aprovo e autorizo o envio. Pode aceitar o resultado.', null, 1]);
  // Spoken or synthesized "approval" stays text under review; it confirms nothing by itself.
  await assert.rejects(h.draft.send(), /confirmation_required/);
  assert.throws(() => h.draft.confirm(scripted), /confirmation_requires_human_gesture/);
  assert.equal(h.sent.length, 0);
  h.draft.confirm(click);
  h.draft.edit('Texto editado depois da confirmação');
  await assert.rejects(h.draft.send(), /confirmation_required/, 'editing after confirmation requires a new confirmation');
  h.draft.confirm(click);
  await h.draft.send();
  assert.deepEqual(h.sent, [{ kind: 'message', text: 'Texto editado depois da confirmação' }]);
  assert.deepEqual([h.draft.state, h.draft.transcript], ['sent', '']);
  await assert.rejects(h.draft.send(), /confirmation_required/);
  assert.equal(h.sent.length, 1);
  assert.equal('approve' in h.draft || 'transition' in h.draft, false, 'voice only produces messages');
});

test('noise, partial or failed transcription and wrong language discard audio and send nothing', async () => {
  for (const [transcript, reason] of [
    [{ text: '   ', language: 'pt-BR', complete: true }, 'no_speech'],
    [{ text: 'Marcar cons', language: 'pt-BR', complete: false }, 'transcription_incomplete'],
    [new Error('provider crashed'), 'transcription_failed'],
    [{ text: 'Book a meeting', language: 'en-US', complete: true }, 'language_mismatch'],
  ] as const) {
    const h = harness({ transcript });
    await h.draft.start(click); await h.draft.stop(click);
    assert.deepEqual([h.draft.state, h.draft.reason, h.draft.transcript, h.draft.audio, h.sent.length], ['failed', reason, '', null, 0], reason);
    assert.throws(() => h.draft.confirm(click), /not_reviewing/);
    assert.ok(voiceMessages[reason], reason);
  }
});

test('cancel stops capture, drops audio and ignores a late transcript', async () => {
  const recording = harness();
  await recording.draft.start(click); recording.draft.cancel();
  assert.deepEqual([recording.draft.state, recording.tracks.stopped, recording.calls.transcribe], ['cancelled', 1, 0]);
  const late = harness();
  await late.draft.start(click);
  const stopping = late.draft.stop(click);
  late.draft.cancel();
  await stopping;
  assert.deepEqual([late.draft.state, late.draft.transcript, late.draft.audio, late.sent.length], ['cancelled', '', null, 0]);
  const reviewed = harness();
  await reviewed.draft.start(click); await reviewed.draft.stop(click); reviewed.draft.cancel();
  assert.deepEqual([reviewed.draft.state, reviewed.draft.transcript], ['cancelled', '']);
  await assert.rejects(reviewed.draft.send(), /confirmation_required/);
});

test('cancellation while microphone permission is pending closes late streams without recording', async () => {
  let grant!: (stream: object) => void;
  let stopped = 0; let recorded = 0;
  const draft = new VoiceDraft({ status: available, provider: {}, media: {
    getUserMedia: () => new Promise(resolve => { grant = resolve; }),
    record: () => { recorded++; return {}; },
  }, onSend: async () => {} });
  const pending = draft.start(click);
  draft.cancel();
  grant({ getTracks: () => [{ stop() { stopped++; } }] });
  await pending;
  assert.deepEqual([draft.state, stopped, recorded], ['cancelled', 1, 0]);
});

test('humanGesture accepts only trusted pointer or keyboard activation', () => {
  assert.equal(humanGesture(click), true);
  assert.equal(humanGesture({ isTrusted: true, type: 'keydown' }), true);
  for (const event of [scripted, { type: 'click' }, { isTrusted: 'true', type: 'click' }, { isTrusted: true, type: 'ended' }, null, undefined]) assert.equal(humanGesture(event), false);
});
