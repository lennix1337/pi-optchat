import { findPackageJSON } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type VoiceConfig = { piVoicePath: string; settingsPath: string };
export type VoiceStatus = { version: 1; state: 'available' | 'blocked'; languages: string[]; reason?: string };
export type VoiceResult = { text: string; language: string; complete: boolean };
export type VoiceProvider = { status(): VoiceStatus; transcribe(input: unknown, signal?: AbortSignal): Promise<VoiceResult> };
export const unavailableVoice: VoiceStatus = { version: 1, state: 'blocked', reason: 'provider_unavailable', languages: [] };
const samplesMax = 16_000 * 30;
const bytesMax = samplesMax * 2;
export const voiceBodyLimit = Math.ceil(bytesMax / 3) * 4 + 1024;

/** Some fixed-language models omit language identification; the explicit `pt` request still applies. */
export function voiceTranscript(result: { text: unknown; language?: string }): VoiceResult {
  if (typeof result.text !== 'string' || result.text.length > 8192) throw new Error('voice_transcript_invalid');
  const language = result.language || 'pt';
  return { text: result.text.trim(), language: language === 'pt' ? 'pt-BR' : language, complete: true };
}

export function validVoiceConfig(value: unknown): value is VoiceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join(',') === 'piVoicePath,settingsPath' &&
    [v.piVoicePath, v.settingsPath].every(path => typeof path === 'string' && isAbsolute(path) && !path.includes('\0'));
}
function json(path: string): Record<string, unknown> {
  if (statSync(path).size > 16_384) throw new Error('voice_configuration_invalid');
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
function settings(config: VoiceConfig): { modelPath: string; modulePath: string } {
  const pkg = json(join(config.piVoicePath, 'package.json'));
  if (pkg.name !== '@earendil-works/pi-voice') throw new Error('voice_configuration_invalid');
  const value = json(config.settingsPath);
  const model = value.model as Record<string, unknown> | undefined;
  const backend = value.backend as Record<string, unknown> | undefined;
  if (value.version !== 1 || backend?.type !== 'transcribe-cpp' || value.transcriptionLanguage !== 'pt' ||
      !model || typeof model.path !== 'string' || !isAbsolute(model.path) || !statSync(model.path).isFile()) throw new Error('voice_configuration_invalid');
  const packagePath = findPackageJSON('transcribe-cpp', pathToFileURL(join(config.piVoicePath, 'index.ts')).href);
  if (!packagePath) throw new Error('voice_backend_missing');
  return { modelPath: model.path, modulePath: join(dirname(packagePath), 'dist', 'index.js') };
}

/** Same local backend, settings and GGUF as Pi Voice/F5. Loads only on an explicit recording, never in health/status. */
export function piVoiceProvider(config: VoiceConfig): VoiceProvider {
  let busy = false;
  return {
    status() {
      try { settings(config); return { version: 1, state: 'available', languages: ['pt-BR'] }; }
      catch { return unavailableVoice; }
    },
    async transcribe(input, signal) {
      signal?.throwIfAborted();
      if (busy) throw new Error('voice_busy');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('voice_audio_invalid');
      const v = input as Record<string, unknown>;
      if (Object.keys(v).sort().join(',') !== 'language,pcm16' || v.language !== 'pt-BR' || typeof v.pcm16 !== 'string' ||
          v.pcm16.length < 4 || v.pcm16.length > voiceBodyLimit - 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.pcm16)) throw new Error('voice_audio_invalid');
      const bytes = Buffer.from(v.pcm16, 'base64');
      if (bytes.length < 2 || bytes.length > bytesMax || bytes.length % 2) throw new Error('voice_audio_invalid');
      const pcm = new Float32Array(bytes.length / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2) / 32768;
      busy = true;
      try {
        const configured = settings(config);
        const { TranscribeModel } = await import(pathToFileURL(configured.modulePath).href);
        const model = await TranscribeModel.load(configured.modelPath);
        try {
          signal?.throwIfAborted();
          if (!model.capabilities.languages.includes('pt')) throw new Error('voice_language_unsupported');
          const result = await model.transcribe(pcm, { language: 'pt', timestamps: 'none', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
          return voiceTranscript(result);
        } finally { model.dispose(); }
      } finally { pcm.fill(0); bytes.fill(0); busy = false; }
    },
  };
}
