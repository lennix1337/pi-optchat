import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piEntryPath = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
const piPackageRoot = resolve(dirname(piEntryPath), '..');
const piPackage = JSON.parse(await readFile(resolve(piPackageRoot, 'package.json'), 'utf8'));
const loaderPath = pathToFileURL(resolve(piPackageRoot, 'dist/core/extensions/loader.js'));
const { loadExtensions } = await import(loaderPath.href);

test('performance diagnostics stay out of default tool schemas and are available on demand', async () => {
  assert.equal(piPackage.version, '1.2.0', 'deferred tool exposure requires the supported Pi runtime');
  const loaded = await loadExtensions([resolve(root, 'src/index.ts')], root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);

  const [extension] = loaded.extensions;
  const registered = extension.tools.get('context_metrics');
  assert.ok(registered, 'performance diagnostics remain registered for optional use');
  assert.equal(registered.definition.defaultActive, false, 'the diagnostic schema must stay out of default active tools');
  assert.equal(registered.definition.exposure, 'deferred', 'tool search should discover the schema only when requested');
  assert.ok(extension.commands.has('optchat-perf'), 'the no-model-call slash command remains available');
});
