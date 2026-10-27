import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piEntryPath = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const piPackageRoot = resolve(dirname(piEntryPath), '..');
const piPackage = JSON.parse(await readFile(resolve(piPackageRoot, 'package.json'), 'utf8'));
const loaderPath = pathToFileURL(resolve(piPackageRoot, 'dist/core/extensions/loader.js'));
const { loadExtensions } = await import(loaderPath.href);
const { emitSessionShutdownEvent } = await import(pathToFileURL(resolve(piPackageRoot, 'dist/core/extensions/runner.js')).href);

test('loads OptChat with Pi 1.2 and registers its tools and lifecycle handlers', async () => {
  assert.equal(piPackage.version, '1.2.0', 'compatibility gate must use the supported Pi runtime');

  const loaded = await loadExtensions([resolve(root, 'src/index.ts')], root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);

  const [extension] = loaded.extensions;
  for (const name of ['shell_start', 'shell_status', 'shell_stop', 'zoom', 'search', 'catchup_report']) {
    assert.ok(extension.tools.has(name), `Pi 1.2 did not register the ${name} tool`);
  }
  assert.ok(extension.commands.has('optchat'), 'Pi 1.2 did not register the /optchat command');
  assert.ok(extension.commands.has('catchup'), 'Pi 1.2 did not register the /catchup command');
  for (const event of ['session_start', 'session_shutdown', 'before_agent_start']) {
    assert.ok(extension.handlers.has(event), `Pi 1.2 did not register the ${event} lifecycle handler`);
  }
});

test('runs OptChat session start and shutdown through Pi 1.2 with an isolated no-profile home', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'pi-optchat-compat-'));
  const home = join(temp, 'optchat-home');
  const previousHome = process.env.OPTCHAT_HOME;
  process.env.OPTCHAT_HOME = home;
  const lifecycle = [], statuses = [], errors = [];
  const lifecycleEvents = new WeakSet();
  let inferenceRequests = 0;
  let session;
  let shutdownEmitted = false;
  try {
    const runtime = await ModelRuntime.create({ authPath: join(temp, 'auth.json'), modelsPath: null,
      modelsStorePath: join(temp, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple() { inferenceRequests++; throw new Error('the compatibility lifecycle test must not request inference'); },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const observedOptchat = pi => optchat(new Proxy(pi, {
      get(target, property, receiver) {
        if (property === 'on') return (event, handler) => target.on(event, ['session_start', 'session_shutdown'].includes(event)
          ? async (...args) => {
            // Pi dispatches one event to multiple handlers (including native-hint cleanup).
            if (!lifecycleEvents.has(args[0])) { lifecycleEvents.add(args[0]); lifecycle.push(event); }
            return handler(...args);
          }
          : handler);
        return Reflect.get(target, property, receiver);
      },
    }));
    const loader = new DefaultResourceLoader({ cwd: temp, agentDir: join(temp, 'agent'), settingsManager,
      noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [observedOptchat] });
    await loader.reload();
    const sessionManager = SessionManager.create(temp, join(temp, 'sessions'));
    ({ session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'),
      resourceLoader: loader, settingsManager, sessionManager, tools: [] }));
    await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error.error),
      uiContext: { ...session.extensionRunner.getUIContext(), select: async () => { throw new Error('no-profile startup must not open a picker'); },
        setStatus: (key, text) => statuses.push([key, text]) } });

    assert.deepEqual(lifecycle, ['session_start']);
    assert.deepEqual(statuses, [['optchat', 'OptChat: choose profile']], 'OptChat session_start ran without selecting a profile');
    assert.deepEqual(errors, []);
    assert.equal(existsSync(home), false, 'no-profile startup must not create a real profile or memory directory');

    assert.equal(await emitSessionShutdownEvent(session.extensionRunner, { type: 'session_shutdown', reason: 'quit' }), true);
    shutdownEmitted = true;
    assert.deepEqual(lifecycle, ['session_start', 'session_shutdown']);
    assert.deepEqual(errors, []);
    assert.equal(existsSync(home), false, 'no-profile shutdown must leave the isolated home untouched');
    assert.equal(inferenceRequests, 0, 'the lifecycle path must not call a model');
  } finally {
    if (session) {
      if (!shutdownEmitted) await emitSessionShutdownEvent(session.extensionRunner, { type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    }
    if (previousHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = previousHome;
    await rm(temp, { recursive: true, force: true });
  }
});
