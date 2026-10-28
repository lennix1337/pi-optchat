// Disposable browser fixture for artifact cards, isolated previews and the blocked voice path.
// No real account, provider, microphone or personal data. Requires an explicit free loopback port.
import { appendFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/store/db.ts';
import { ArtifactRegistry } from '../src/artifacts/registry.ts';
import { createAssistantServer } from '../src/http/server.ts';

const port = Number(process.env.ASSISTANT_ARTIFACT_BROWSER_PORT);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || port === 43218) throw new Error('Set ASSISTANT_ARTIFACT_BROWSER_PORT to a free loopback port other than 43218');
const dir = resolve(process.env.ASSISTANT_BROWSER_EVIDENCE ?? 'C:/projetos/local-validation/runs/personal-assistant-parity/t12-browser', `run-${Date.now()}`);
const sources = join(dir, 'skill-output');
mkdirSync(dir, { recursive: true });
cpSync(fileURLToPath(new URL('./fixtures/artifacts/', import.meta.url)), sources, { recursive: true });
const profileId = 'artifact-browser';
const store = new TaskStore(join(dir, 'tasks.db'), profileId);
const registry = new ArtifactRegistry({ databasePath: join(dir, 'artifacts.db'), profileId, root: join(dir, 'managed'), sourceRoots: [sources] });
const samples = [['relatorio-semanal.md', 'document'], ['apresentacao.html', 'slides'], ['pagina-inicial.html', 'page'], ['painel-metricas.html', 'dashboard'], ['cartao-visual.svg', 'design'], ['tokens.json', 'design_system'], ['pagina-hostil.html', 'page']];
const registered = samples.map(([file, type]) => registry.register({ sourcePath: join(sources, file), type, ownerId: 'operator', producerId: 'fixture:hand-authored', provenance: `fixture://t12/${file}` }));
writeFileSync(join(sources, 'pagina-inicial.html'), '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>v2</title><p>Página, versão 2</p></html>');
registry.register({ sourcePath: join(sources, 'pagina-inicial.html'), type: 'page', ownerId: 'operator', producerId: 'fixture:hand-authored', provenance: 'fixture://t12/pagina-inicial.html#v2', artifactId: registered[2].artifactId });
const server = createAssistantServer({ store, token: 'DISPOSABLE-BROWSER-ONLY', profileId, web: true, artifacts: registry });
// Every request path is recorded so hostile-preview requests would be visible evidence.
server.on('request', req => appendFileSync(join(dir, 'requests.log'), `${req.method} ${req.url}\n`));
function close() { clearTimeout(deadline); server.closeAllConnections(); server.close(() => { registry.close(); store.close(); console.log('DISPOSABLE_ARTIFACT_FIXTURE_CLOSED'); }); }
const deadline = setTimeout(close, 15 * 60_000);
process.on('SIGTERM', close); process.on('SIGINT', close);
server.listen(port, '127.0.0.1', () => {
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ pid: process.pid, base: `http://127.0.0.1:${port}`, dir }));
  console.log(`DISPOSABLE_ARTIFACT_FIXTURE_READY http://127.0.0.1:${port} ${dir}`);
});
