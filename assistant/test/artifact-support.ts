import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactRegistry, type ArtifactType } from '../src/artifacts/registry.ts';
import { createAssistantServer } from '../src/http/server.ts';
import { TaskStore } from '../src/store/db.ts';

export const profileId = 'artifact-profile';
export const token = 'DISPOSABLE-ARTIFACT-TEST-TOKEN';
export const samplesDir = fileURLToPath(new URL('./fixtures/artifacts/', import.meta.url));
/** One hand-authored stand-in per supported type; producer IDs name the skills whose outputs they represent. */
export const samples: { type: ArtifactType; file: string; producerId: string; previewType: string; downloadType: string }[] = [
  { type: 'document', file: 'relatorio-semanal.md', producerId: 'skill:writing-plans', previewType: 'text/plain; charset=utf-8', downloadType: 'text/markdown; charset=utf-8' },
  { type: 'slides', file: 'apresentacao.html', producerId: 'skill:frontend-design', previewType: 'text/html; charset=utf-8', downloadType: 'text/html; charset=utf-8' },
  { type: 'page', file: 'pagina-inicial.html', producerId: 'skill:frontend-design', previewType: 'text/html; charset=utf-8', downloadType: 'text/html; charset=utf-8' },
  { type: 'dashboard', file: 'painel-metricas.html', producerId: 'skill:impeccable', previewType: 'text/html; charset=utf-8', downloadType: 'text/html; charset=utf-8' },
  { type: 'design', file: 'cartao-visual.svg', producerId: 'skill:implement-design', previewType: 'image/svg+xml', downloadType: 'image/svg+xml' },
  { type: 'design_system', file: 'tokens.json', producerId: 'skill:ui-ux-pro-max', previewType: 'text/plain; charset=utf-8', downloadType: 'application/json' },
];

export type Paths = { dir: string; sources: string; root: string; database: string };
export type Opened = {
  registry: ArtifactRegistry; server: Server; base: string;
  fetch: (path: string, options?: RequestInit) => Promise<Response>;
  login: () => Promise<{ cookie: string; csrf: string }>;
  close: () => Promise<void>;
};

async function open(paths: Paths): Promise<Opened> {
  const store = new TaskStore(':memory:', profileId);
  const registry = new ArtifactRegistry({ databasePath: paths.database, profileId, root: paths.root, sourceRoots: [paths.sources] });
  const server = createAssistantServer({ store, token, profileId, web: true, artifacts: registry });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, options: RequestInit = {}) => fetch(base + path, options);
  const login = async () => {
    const res = await request('/web/session', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(res.status, 200);
    const { csrf } = await res.json() as { csrf: string };
    return { cookie: res.headers.get('set-cookie')!.split(';')[0], csrf };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    registry.close(); store.close();
  };
  return { registry, server, base, fetch: request, login, close };
}

/** Disposable producer-output folder, managed artifact root and registry database that survive a server restart. */
export async function artifactFixture(fn: (f: { paths: Paths; current: () => Opened; restart: () => Promise<Opened> }) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-artifacts-'));
  const paths: Paths = { dir, sources: join(dir, 'skill-output'), root: join(dir, 'managed-artifacts'), database: join(dir, 'artifacts.db') };
  cpSync(samplesDir, paths.sources, { recursive: true });
  let opened = await open(paths);
  try {
    await fn({ paths, current: () => opened, restart: async () => { await opened.close(); opened = await open(paths); return opened; } });
  } finally { await opened.close(); rmSync(dir, { recursive: true, force: true }); }
}

export function client(opened: Opened, session: { cookie: string; csrf: string }) {
  const headers = { origin: opened.base, cookie: session.cookie, 'x-assistant-csrf': session.csrf, 'content-type': 'application/json' };
  const post = (path: string, body: object = {}) => opened.fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const get = (path: string) => opened.fetch(path, { headers: { cookie: session.cookie } });
  const version = (id: string, n: number) => `/web/api/artifacts/${encodeURIComponent(id)}/versions/${n}`;
  const preview = async (id: string, n: number) => {
    const issued = await post(`${version(id, n)}/preview`);
    assert.equal(issued.status, 200);
    const { url } = await issued.json() as { url: string; expiresAt: string };
    return { url, response: await get(url) };
  };
  return { post, get, version, preview };
}
