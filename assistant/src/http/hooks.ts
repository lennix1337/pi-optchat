import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RoutineEvent } from '../routines/manager.ts';
import { BadRequest, query, readRaw, send } from './io.ts';

/**
 * Inbound events for event routines. A source authenticates itself; the service bearer token never does. `github`
 * checks `X-Hub-Signature-256` (HMAC-SHA256 of the raw body); `shared` compares a secret header. The delivery id is
 * the idempotency key, so a source that retries is safe. The route lives on the loopback listener only: reaching it
 * from outside is the operator's own proxy decision.
 */
export type HookSource = { format: 'github' | 'shared'; secret: string };
export type EventIntake = { sources: Readonly<Record<string, HookSource>>; accept(event: RoutineEvent): { created: number; duplicate: number } };

const DELIVERY = /^[A-Za-z0-9._:-]{1,100}$/u;
const EVENT_TYPE = /^[A-Za-z0-9._:-]{1,60}$/u;
const HEADERS = {
  github: { delivery: 'x-github-delivery', type: 'x-github-event' },
  shared: { delivery: 'x-delivery-id', type: 'x-event-type' },
} as const;
export const SHARED_SECRET_HEADER = 'x-webhook-secret';

const header = (req: IncomingMessage, name: string): string => { const value = req.headers[name]; return typeof value === 'string' ? value : ''; };
function same(supplied: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected)) && supplied.length > 0;
}

export function authentic(source: HookSource, req: IncomingMessage, raw: Buffer): boolean {
  if (source.format === 'shared') return same(header(req, SHARED_SECRET_HEADER), source.secret);
  return same(header(req, 'x-hub-signature-256'), `sha256=${createHmac('sha256', source.secret).update(raw).digest('hex')}`);
}

/** `POST /v1/hooks/<source>`: 401 unless signed, 400 without a usable delivery id, else 200 with how many tasks it queued. */
export async function hookRoute(req: IncomingMessage, res: ServerResponse, url: URL, intake: EventIntake): Promise<void> {
  const name = /^\/v1\/hooks\/([a-z0-9][a-z0-9_-]{0,63})$/u.exec(url.pathname)?.[1];
  const source = name !== undefined && Object.hasOwn(intake.sources, name) ? intake.sources[name] : undefined;
  if (req.method !== 'POST' || !name || !source) { send(res, 404, { error: 'Not found' }); return; }
  query(url, []);
  const raw = await readRaw(req);
  if (!authentic(source, req, raw)) { send(res, 401, { error: 'Unauthorized' }); return; }
  const names = HEADERS[source.format];
  const deliveryId = header(req, names.delivery);
  const type = header(req, names.type);
  if (!DELIVERY.test(deliveryId) || (type !== '' && !EVENT_TYPE.test(type))) throw new BadRequest();
  send(res, 200, { ok: true, ...intake.accept({ source: name, deliveryId, type: type || null, body: raw.toString('utf8') }) });
}
