import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'assistant-artifact-mutants-'));
const tests = ['artifact-flow.test.ts', 'preview-isolation.test.ts', 'voice-flow.test.ts', 'voice-lifecycle.test.mjs'];
// [name, file, exact source, replacement, expected failure]
const variants = [
  ['managed-root-traversal', 'src/artifacts/registry.ts', "if (!inside(this.root, path) || (existsSync(path) && !inside(this.root, realpathSync(path)))) fail('artifact_location_invalid');", '', /expected: \/artifact_location_invalid\//],
  ['source-root', 'src/artifacts/registry.ts', "if (!this.sourceRoots.some(root => inside(root, real))) fail('artifact_source_outside_roots');", '', /expected: \/artifact_source_outside_roots\//],
  ['integrity-hash', 'src/artifacts/registry.ts', "if (sha256(bytes) !== record.hash) fail('artifact_changed');", '', /expected: \/artifact_changed\//],
  ['preview-sandbox', 'src/artifacts/preview.ts', 'return `sandbox; default-src', 'return `default-src', /sandbox without allow-scripts/],
  ['preview-script', 'src/artifacts/preview.ts', "default-src 'none'; style-src", "default-src 'none'; script-src 'unsafe-inline'; style-src", /true !== false/],
  ['panel-iframe-sandbox', 'web/index.html', ' sandbox="" referrerpolicy', ' referrerpolicy', /sandbox=""/],
  ['download-auth', 'src/channels/web.ts', 'const [id, session] = this.current(req);', "if (ArtifactRoutes.owns(url.pathname) && this.artifacts) { await this.artifacts.handle(req, res, url, { sessionId: 'anonymous', host, headers: securityHeaders, stillCurrent: () => true }); return; }\n    const [id, session] = this.current(req);", /200 !== 401/],
  ['preview-session-binding', 'src/artifacts/preview.ts', 'grant.sessionId !== access.sessionId || ', '', /another browser session cannot use this capability/],
  ['preview-expiry', 'src/artifacts/preview.ts', ' || grant.expires <= this.now()) {', ') {', /expired capability/],
  ['review-in-flight-revocation', 'src/channels/web.ts', 'stillCurrent: () => this.stillCurrent(req, id!, session)', 'stillCurrent: () => true', /200 !== 401/],
  ['confirmation-before-send', 'web/src/voice/voice.js', "if (this.state !== 'confirmed') throw new Error('confirmation_required');", '', /confirmation_required/],
  ['human-gesture', 'web/src/voice/voice.js', 'return event?.isTrusted === true && gestures.has(event.type);', 'return gestures.has(event?.type);', /human_gesture/],
  ['audio-retention', 'web/src/voice/voice.js', 'finally { if (draft.captureGeneration === generation) draft.audio = null; }', '', /fixture-audio/],
  ['cancelled-microphone', 'web/src/voice/voice.js', "if (draft.state !== 'requesting' || draft.captureGeneration !== generation) { stopTracks(stream); return; }", '', /cancellation while microphone/],
  ['cancel-before-upload', 'web/src/voice/media.js', '    signal?.throwIfAborted();\n    return request', '    return request', /cancel or logout during conversion/],
  ['cancel-signal-forwarding', 'web/src/voice/voice.js', 'draft.provider.transcribe(audio, draft.language, signal)', 'draft.provider.transcribe(audio, draft.language)' , /cancel or logout during conversion/],
  ['late-voice-status', 'web/src/voice/voice-ui.js', '  if (lifecycle !== generation) return;', '', /late status responses/],
  ['automatic-stop-state', 'web/src/voice/voice.js', "else draft.state = 'captured';", 'else {}', /automatic capture stop/],
];
try {
  for (const [name, file, before, after, expected] of variants) {
    const dir = join(root, name); mkdirSync(join(dir, 'test'), { recursive: true });
    for (const folder of ['src', 'web']) cpSync(join(sourceRoot, folder), join(dir, folder), { recursive: true });
    cpSync(join(sourceRoot, 'package.json'), join(dir, 'package.json'));
    cpSync(join(sourceRoot, 'test', 'fixtures'), join(dir, 'test', 'fixtures'), { recursive: true });
    for (const test of [...tests, 'artifact-support.ts']) cpSync(join(sourceRoot, 'test', test), join(dir, 'test', test));
    const target = join(dir, file);
    const source = readFileSync(target, 'utf8'); assert.equal(source.split(before).length, 2, `nonunique mutant ${name}`);
    writeFileSync(target, source.replace(before, after));
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', ...tests.map(test => join(dir, 'test', test))], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 1, `${name}: ${result.error ?? result.stderr}`);
    assert.match(result.stdout, /AssertionError/, name); assert.match(result.stdout, expected, name);
    console.log(`killed ${name}`);
  }
  console.log(JSON.stringify({ mutants: variants.length, killed: variants.length, survivors: 0 }));
} finally { rmSync(root, { recursive: true, force: true }); }
