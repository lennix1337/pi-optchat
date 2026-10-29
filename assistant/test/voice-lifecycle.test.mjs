import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { VoiceDraft } from '../web/src/voice/voice.js';
import { browserMedia, localVoiceProvider } from '../web/src/voice/media.js';
test('the registered logout click stops voice immediately even when logout waits or fails', async () => {
  const source = readFileSync(new URL('../web/src/app.js', import.meta.url), 'utf8');
  const handlerSource = source.slice(source.indexOf("$('#logout').addEventListener"), source.indexOf("$('#theme').addEventListener"));
  for (const fail of [false, true]) {
    let handler; let finish; let stopped = 0;
    runInNewContext(handlerSource, { $: () => ({ addEventListener: (_event, callback) => { handler = callback; } }),
      stopVoice: () => stopped++, signedOut() {}, notice() {}, request: () => new Promise((resolve, reject) => { finish = () => fail ? reject(new Error('offline')) : resolve(); }) });
    const pending = handler(); assert.equal(stopped, 1); finish(); await pending; assert.equal(stopped, 1);
  }
});

test('recorder error followed by stop stays failed, never a successful timed capture', async t => {
  let recorder; let stops = 0;
  class Recorder extends EventTarget { state = 'inactive'; constructor() { super(); recorder = this; } start() { this.state = 'recording'; } stop() { this.state = 'inactive'; this.dispatchEvent(new Event('stop')); } }
  const originalRecorder = Object.getOwnPropertyDescriptor(globalThis, 'MediaRecorder');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stops++; } }] }) } } });
  t.after(() => { for (const [name, original] of [['MediaRecorder', originalRecorder], ['navigator', originalNavigator]]) { if (original) Object.defineProperty(globalThis, name, original); else delete globalThis[name]; } });
  const draft = new VoiceDraft({ status: available, provider: {}, media: browserMedia(), onSend: async () => {} });
  await draft.start(click); recorder.dispatchEvent(new Event('error')); recorder.stop();
  assert.equal(draft.state, 'failed'); assert.equal(draft.reason, 'capture_failed'); assert.ok(stops > 0);
});

const click = { isTrusted: true, type: 'click' };
const available = { version: 1, state: 'available', languages: ['pt-BR'] };

test('cancel or logout during conversion prevents upload; cancellation aborts a request already started', async () => {
  let encoded; let encoding;
  let requests = 0; let requestSignal;
  const provider = localVoiceProvider(async (_url, _body, options) => { requests++; requestSignal = options.signal; if (options.signal?.aborted) throw options.signal.reason; return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })); },
    () => { encoding?.(); return new Promise(resolve => { encoded = resolve; }); });
  const draft = new VoiceDraft({ status: available, provider, media: { getUserMedia: async () => ({ getTracks: () => [] }), record: () => ({ stop: async () => 'audio' }) }, onSend: async () => assert.fail('no send before confirmation') });
  let started = new Promise(resolve => { encoding = resolve; });
  await draft.start(click);
  const stopping = draft.stop(click); await started;
  draft.cancel(); encoded('AAAAAA=='); await stopping;
  assert.equal(requests, 0); assert.equal(draft.state, 'cancelled');
  started = new Promise(resolve => { encoding = resolve; });
  await draft.start(click);
  const next = draft.stop(click); await started; encoded('AAAAAA==');
  await Promise.resolve();
  assert.equal(requests, 1);
  draft.cancel(); await next;
  assert.equal(requestSignal.aborted, true); assert.equal(draft.state, 'cancelled');
});

test('automatic capture stop updates the draft and still requires explicit transcription and confirmation', async () => {
  let stopped; let changes = 0; let transcriptions = 0;
  const draft = new VoiceDraft({ status: available, provider: { async transcribe() { transcriptions++; return { text: 'tarefa local', language: 'pt-BR', complete: true }; } },
    media: { getUserMedia: async () => ({ getTracks: () => [] }), record: (_stream, callback) => { stopped = callback; return { stop: async () => 'audio' }; } }, onSend: async () => {}, onChange: () => changes++ });
  await draft.start(click); stopped();
  assert.deepEqual([draft.state, changes, transcriptions], ['captured', 1, 0]);
  await draft.stop(click); assert.equal(draft.state, 'review'); assert.equal(transcriptions, 1);
  await assert.rejects(draft.send(), /confirmation_required/);
});

test('late status responses cannot revive voice after logout or replace a newer session', async t => {
  const nodes = new Map();
  const element = selector => { if (!nodes.has(selector)) nodes.set(selector, { hidden: true, value: '', disabled: true, textContent: '', addEventListener() {} }); return nodes.get(selector); };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: element, activeElement: null } });
  t.after(() => { if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document; });
  const { startVoice, stopVoice } = await import('../web/src/voice/voice-ui.js');
  let oldStatus;
  const pending = startVoice(() => new Promise(resolve => { oldStatus = resolve; }), async () => {});
  stopVoice(); oldStatus(available); await pending;
  assert.equal(element('#voice-record').disabled, true);
  const stale = startVoice(() => new Promise(resolve => { oldStatus = resolve; }), async () => {});
  await startVoice(async () => ({ version: 1, state: 'blocked', languages: [] }), async () => {});
  oldStatus(available); await stale;
  assert.equal(element('#voice-record').disabled, true);
  assert.match(element('#voice-status').textContent, /indisponível/);
  stopVoice();
});
