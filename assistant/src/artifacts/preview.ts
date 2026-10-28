import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { extname } from 'node:path';
import { oneOf } from '../contracts/validation.ts';
import { BadRequest, query, readBody, send, shape, taskIdParam } from '../http/io.ts';
import type { ArtifactRecord, ArtifactRegistry, ReviewDecision } from './registry.ts';

const previewTtlMs = 5 * 60_000;
const maxPreviews = 256;
/** Media type for download, and the type an untrusted preview renders as. */
const mediaTypes: ReadonlyMap<string, { download: string; preview: string }> = new Map([
  ['.md', { download: 'text/markdown; charset=utf-8', preview: 'text/plain; charset=utf-8' }],
  ['.html', { download: 'text/html; charset=utf-8', preview: 'text/html; charset=utf-8' }],
  ['.svg', { download: 'image/svg+xml', preview: 'image/svg+xml' }],
  ['.json', { download: 'application/json', preview: 'text/plain; charset=utf-8' }],
  ['.css', { download: 'text/css; charset=utf-8', preview: 'text/plain; charset=utf-8' }],
]);
/** Registry refusals that mean "this version cannot be served as registered", not a client mistake. */
const unavailable = new Set(['artifact_changed', 'artifact_location_invalid']);

/**
 * Artifact bytes are untrusted. `sandbox` with no allowances gives the document an opaque origin with no
 * script, form, popup or top navigation, so it cannot read the panel cookie or call the panel API; network
 * fetches are refused except inline data. Only the panel origin may frame it.
 */
export function previewPolicy(panelOrigin: string): string {
  return `sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-ancestors ${panelOrigin}`;
}
export function contentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export type PanelAccess = { sessionId: string; host: string; headers: Record<string, string>; stillCurrent: () => boolean };
type Preview = { sessionId: string; artifactId: string; artifactVersion: number; expires: number };

/** Authenticated panel routes for listing, reviewing, previewing and downloading registered artifacts. */
export class ArtifactRoutes {
  private readonly previews = new Map<string, Preview>();
  private readonly registry: ArtifactRegistry;
  private readonly now: () => number;
  constructor(registry: ArtifactRegistry, now: () => number) { this.registry = registry; this.now = now; }
  static owns(pathname: string): boolean { return pathname === '/web/api/artifacts' || pathname.startsWith('/web/api/artifacts/') || pathname.startsWith('/web/preview/'); }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, access: PanelAccess): Promise<void> {
    try { await this.route(req, res, url, access); } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'artifact_not_found') send(res, 404, { error: 'Not found' }, access.headers);
      else if (code === 'artifact_already_reviewed') send(res, 409, { error: 'Conflict' }, access.headers);
      else if (unavailable.has(code)) send(res, 409, { error: 'Artifact unavailable' }, access.headers);
      else if (code === 'artifact_type_unsupported' || code === 'artifact_invalid') throw new BadRequest();
      else throw error;
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL, access: PanelAccess): Promise<void> {
    const preview = /^\/web\/preview\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
    const one = /^\/web\/api\/artifacts\/([^/]+)$/.exec(url.pathname);
    const version = /^\/web\/api\/artifacts\/([^/]+)\/versions\/([1-9]\d{0,8})\/(preview|review|download)$/.exec(url.pathname);
    if (req.method === 'GET' && url.pathname === '/web/api/artifacts') {
      query(url, ['type']);
      send(res, 200, this.registry.list(url.searchParams.get('type') ?? undefined), access.headers); return;
    }
    if (req.method === 'GET' && one) {
      query(url, []);
      const versions = this.registry.versions(taskIdParam(one[1]));
      send(res, versions.length ? 200 : 404, versions.length ? { versions } : { error: 'Not found' }, access.headers); return;
    }
    if (req.method === 'GET' && preview) { query(url, []); this.preview(res, preview[1], access); return; }
    if (!version) { send(res, 404, { error: 'Not found' }, access.headers); return; }
    const artifactId = taskIdParam(version[1]);
    const artifactVersion = Number(version[2]);
    query(url, []);
    if (req.method === 'GET' && version[3] === 'download') {
      const { record, bytes } = this.registry.read(artifactId, artifactVersion);
      this.serve(res, access, record, bytes, 'download'); return;
    }
    if (req.method !== 'POST' || version[3] === 'download') { send(res, 404, { error: 'Not found' }, access.headers); return; }
    const body = await readBody(req);
    if (!access.stillCurrent()) { send(res, 401, { error: 'Unauthorized' }, access.headers); return; }
    if (version[3] === 'review') {
      shape(body, { decision: oneOf('approved', 'rejected') });
      send(res, 200, this.registry.review(artifactId, artifactVersion, (body as { decision: ReviewDecision }).decision, 'web-operator'), access.headers); return;
    }
    shape(body, {});
    if (!this.registry.get(artifactId, artifactVersion)) { send(res, 404, { error: 'Not found' }, access.headers); return; }
    const now = this.now();
    for (const [key, value] of this.previews) if (value.expires <= now) this.previews.delete(key);
    if (this.previews.size >= maxPreviews) { send(res, 429, { error: 'Too many previews' }, access.headers); return; }
    const token = randomBytes(32).toString('base64url');
    const expires = now + previewTtlMs;
    this.previews.set(token, { sessionId: access.sessionId, artifactId, artifactVersion, expires });
    send(res, 200, { url: `/web/preview/${token}`, expiresAt: new Date(expires).toISOString() }, access.headers);
  }

  /** A preview capability opens one version for the browser session that requested it, until it expires. */
  private preview(res: ServerResponse, token: string, access: PanelAccess): void {
    const grant = this.previews.get(token);
    if (!grant || grant.sessionId !== access.sessionId || grant.expires <= this.now()) { send(res, 404, { error: 'Not found' }, access.headers); return; }
    const { record, bytes } = this.registry.read(grant.artifactId, grant.artifactVersion);
    this.serve(res, access, record, bytes, 'preview');
  }
  private serve(res: ServerResponse, access: PanelAccess, record: ArtifactRecord, bytes: Buffer, mode: 'preview' | 'download'): void {
    const type = mediaTypes.get(extname(record.fileName).toLowerCase());
    if (!type) throw new Error('artifact_location_invalid');
    const headers: Record<string, string> = { ...access.headers, 'content-security-policy': previewPolicy(`http://${access.host}`), 'content-type': type[mode], 'content-length': String(bytes.length) };
    if (mode === 'download') headers['content-disposition'] = contentDisposition(record.fileName);
    res.writeHead(200, headers);
    res.end(bytes);
  }
}
